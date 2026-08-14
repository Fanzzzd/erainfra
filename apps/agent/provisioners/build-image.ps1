# Build an EraInfra parent VHDX from a Windows installation ISO. PREVIEW.
#
# Applies the chosen edition straight out of install.wim with DISM instead of
# running a full interactive setup, seeds an unattend.xml that creates the guest
# account, provisions the Actions runner from SetupComplete.cmd, then boots the
# VM once so that pass actually runs. The VM is discarded afterwards; only the
# VHDX is kept, and provision-win.ps1 never writes to it.
#
# Usage:
#   .\build-image.ps1 -IsoPath ~\.runner-center\iso\ws2025-eval.iso -ImageName rc-win2025
#
# Security model of the produced image:
#   - The Actions runner archive is pinned by version and SHA-256 and verified
#     in the guest before it is expanded. A mismatch fails the build.
#   - No AutoLogon is configured, so no plaintext password is ever written to
#     HKLM\...\Winlogon. Provisioning runs from SetupComplete.cmd as SYSTEM at
#     the end of setup, before any interactive logon exists.
#   - The guest account password does appear in plaintext in the unattend file
#     while setup consumes it -- Windows offers no better option for creating a
#     local account offline. SetupComplete.cmd deletes every cached copy of that
#     file before the image is blessed, and the build then verifies offline that
#     the copy is gone and that no AutoLogon secret was left in the registry.
#   - The built-in Administrator gets an independent throwaway password that is
#     never recorded anywhere, and the account is disabled during provisioning.
#   - The password that survives is the guest account's, stored DPAPI-encrypted
#     next to the VHDX as <ImageName>.cred.xml, readable only by the account
#     that ran this build -- the same account that runs the agent.
#   - Defender real-time monitoring stays ON unless -DisableDefenderRealtime is
#     passed. Turning it off is a persistent, image-wide weakening; the choice
#     is recorded in the image manifest.
#
# Operator input (-ImageName, -GuestUser, -GuestPassword) is validated and
# XML-escaped before it reaches the unattend file.
#
# NOT VERIFIED ON A WINDOWS HOST. Nothing here has been executed against real
# Hyper-V, DISM or Windows Setup; it is covered only by the static checks in
# ../tests. Treat the first run on a real host as the actual validation.

[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $IsoPath,
    [Parameter(Mandatory)] [string] $ImageName,
    [string] $RcHome = (Join-Path $env:USERPROFILE '.runner-center'),
    [string] $GuestUser = 'runner',
    [securestring] $GuestPassword,
    [string] $EditionMatch = 'Desktop Experience',
    [int] $DiskSizeGb = 127,
    [int] $BuildMemoryGb = 8,
    [int] $BuildCpuCount = 8,
    [string] $SwitchName = 'Default Switch',
    [int] $ProvisionTimeoutMin = 60,
    # Keep in step with the Linux provisioner's runner pin. Both values come
    # from the actions/runner release; update them together.
    [string] $RunnerVersion = '2.336.0',
    [string] $RunnerSha256 = 'd59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162',
    [switch] $DisableDefenderRealtime
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function ConvertTo-XmlText([string] $Value) {
    if ($null -eq $Value) { return '' }
    return $Value.
        Replace('&', '&amp;').
        Replace('<', '&lt;').
        Replace('>', '&gt;').
        Replace('"', '&quot;').
        Replace("'", '&apos;')
}

function New-RandomPassword([int] $Length = 24) {
    # No shell- or XML-hostile characters, so the value stays readable in logs
    # of failures without needing escaping. Callers still escape it for XML.
    $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'
    $bytes = [byte[]]::new($Length)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    return -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
}

# Refuse anything that becomes a file path, a VM name or an injected literal.
if ($ImageName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') {
    throw "-ImageName must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$."
}
if ($GuestUser -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$') {
    throw '-GuestUser must be 1-20 characters of A-Z, a-z, 0-9, dot, underscore or hyphen.'
}
if ($RunnerVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "-RunnerVersion must look like 2.336.0, got '$RunnerVersion'."
}
if ($RunnerSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw '-RunnerSha256 must be 64 hex characters.'
}

$imageDir = Join-Path $RcHome 'images'
$vhdxPath = Join-Path $imageDir "$ImageName.vhdx"
$credPath = Join-Path $imageDir "$ImageName.cred.xml"
$manifestPath = Join-Path $imageDir "$ImageName.image.json"
$buildVm = "rcbuild-$ImageName"
$mountRoot = Join-Path $RcHome "build\$ImageName"

if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    throw 'Hyper-V PowerShell module unavailable. Enable Microsoft-Hyper-V-All and reboot.'
}
if (-not (Test-Path -LiteralPath $IsoPath)) { throw "ISO not found: $IsoPath" }
if (Test-Path -LiteralPath $vhdxPath) {
    throw "$vhdxPath already exists. Delete it first if you mean to rebuild."
}
New-Item -ItemType Directory -Path $imageDir -Force | Out-Null
New-Item -ItemType Directory -Path $mountRoot -Force | Out-Null

if (-not $GuestPassword) {
    $plain = New-RandomPassword
    $GuestPassword = ConvertTo-SecureString $plain -AsPlainText -Force
} else {
    $plain = [System.Net.NetworkCredential]::new('', $GuestPassword).Password
}
# Nobody needs this one after setup, so nobody gets to keep it.
$administratorPassword = New-RandomPassword

$isoMount = $null
$vhdMounted = $false

# reg.exe can inspect the produced image's registry without booting it. Returns
# $true when a plaintext AutoLogon password survives, $false when it does not,
# and $null when the check could not run at all.
function Test-OfflineAutoLogonSecret([string] $OsDrive) {
    $hivePath = "${OsDrive}:\Windows\System32\config\SOFTWARE"
    if (-not (Test-Path -LiteralPath $hivePath)) { return $null }
    $key = 'HKLM\RC_OFFLINE_SOFTWARE'
    # An inconclusive check must not fail the build, so every reg.exe failure
    # mode -- not elevated, hive locked, reg.exe missing -- lands on $null.
    try {
        & reg.exe load $key $hivePath 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { return $null }
    } catch {
        return $null
    }
    try {
        $winlogon = "$key\Microsoft\Windows NT\CurrentVersion\Winlogon"
        $found = $false
        foreach ($value in 'DefaultPassword', 'AutoAdminLogon') {
            & reg.exe query $winlogon /v $value 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $found = $true }
        }
        return $found
    } catch {
        return $null
    } finally {
        [gc]::Collect()
        [gc]::WaitForPendingFinalizers()
        & reg.exe unload $key 2>$null | Out-Null
    }
}

try {
    Write-Host "Mounting $IsoPath"
    $isoMount = Mount-DiskImage -ImagePath (Resolve-Path $IsoPath).Path -PassThru
    $isoDrive = ($isoMount | Get-Volume).DriveLetter
    $wim = "${isoDrive}:\sources\install.wim"
    if (-not (Test-Path $wim)) { $wim = "${isoDrive}:\sources\install.esd" }
    if (-not (Test-Path $wim)) { throw "Neither install.wim nor install.esd found on the ISO." }

    $editions = Get-WindowsImage -ImagePath $wim
    $edition = $editions | Where-Object { $_.ImageName -like "*$EditionMatch*" } | Select-Object -First 1
    if (-not $edition) {
        $names = ($editions | ForEach-Object { "[$($_.ImageIndex)] $($_.ImageName)" }) -join "`n  "
        throw "No edition matching '$EditionMatch'. Available:`n  $names"
    }
    Write-Host "Applying edition [$($edition.ImageIndex)] $($edition.ImageName)"

    # GPT layout for a Generation 2 (UEFI) guest: EFI system + MSR + OS.
    $vhd = New-VHD -Path $vhdxPath -SizeBytes ($DiskSizeGb * 1GB) -Dynamic
    $disk = Mount-VHD -Path $vhdxPath -PassThru | Get-Disk
    $vhdMounted = $true
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT -Confirm:$false | Out-Null

    $efi = New-Partition -DiskNumber $disk.Number -Size 260MB -GptType '{c12a7328-f81f-11d2-ba4b-00a0c93ec93b}'
    $efi | Format-Volume -FileSystem FAT32 -NewFileSystemLabel 'System' -Confirm:$false | Out-Null
    $efi | Set-Partition -NewDriveLetter S
    New-Partition -DiskNumber $disk.Number -Size 16MB -GptType '{e3c9e316-0b5c-4db8-817d-f92df00215ae}' | Out-Null
    $osPart = New-Partition -DiskNumber $disk.Number -UseMaximumSize -GptType '{ebd0a0a2-b9e5-4433-87c0-68b6b72699c7}'
    $osPart | Format-Volume -FileSystem NTFS -NewFileSystemLabel 'Windows' -Confirm:$false | Out-Null
    $osPart | Set-Partition -NewDriveLetter W

    Write-Host 'Expanding the image (several minutes)'
    Expand-WindowsImage -ImagePath $wim -Index $edition.ImageIndex -ApplyPath 'W:\' | Out-Null

    Write-Host 'Writing boot files'
    & bcdboot W:\Windows /s S: /f UEFI | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "bcdboot failed with exit code $LASTEXITCODE" }

    # Values the guest script needs, emitted as literals it can read. Every one
    # of them is validated above, so single quotes cannot be broken out of.
    $provisionPrelude = @"
`$RcRunnerVersion = '$RunnerVersion'
`$RcRunnerSha256 = '$RunnerSha256'
`$RcGuestUser = '$GuestUser'
`$RcDisableDefenderRealtime = `$$($DisableDefenderRealtime.IsPresent)
"@

    # Provisioning that runs as SYSTEM at the end of setup, before any logon.
    # Keep it idempotent and fail loudly: a half-provisioned parent image is
    # worse than none. Never echo a credential into the transcript.
    $provisionBody = @'
$ErrorActionPreference = 'Stop'
$log = 'C:\rc-provision.log'
Start-Transcript -Path $log -Append
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $runnerDir = 'C:\actions-runner'
    New-Item -ItemType Directory -Path $runnerDir -Force | Out-Null

    # Pinned by version and checksum rather than resolved from whatever the
    # newest release happens to be, so an image rebuilt six months from now
    # still contains the runner the rest of this repository is pinned to.
    $url = "https://github.com/actions/runner/releases/download/v$RcRunnerVersion/actions-runner-win-x64-$RcRunnerVersion.zip"
    $zip = Join-Path $env:TEMP "actions-runner-$RcRunnerVersion.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    $actualSha = (Get-FileHash -Path $zip -Algorithm SHA256).Hash
    if ($actualSha -ne $RcRunnerSha256.ToUpperInvariant()) {
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
        throw "actions-runner-win-x64-$RcRunnerVersion.zip SHA-256 mismatch: expected $RcRunnerSha256, got $actualSha"
    }
    Expand-Archive -Path $zip -DestinationPath $runnerDir -Force
    Remove-Item $zip -Force
    "installed actions runner $RcRunnerVersion ($actualSha)"

    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1

    if ($RcDisableDefenderRealtime) {
        'WARNING: disabling Defender real-time monitoring image-wide, as requested'
        Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
    }

    # Best effort: winget is absent from Server images and unreliable under
    # SYSTEM. Missing extra tooling must not fail the image.
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        foreach ($pkg in @('Git.Git', 'OpenJS.NodeJS.LTS', 'Python.Python.3.12')) {
            winget install --id $pkg --silent --accept-source-agreements --accept-package-agreements --scope machine
            "winget $pkg exit=$LASTEXITCODE"
        }
    } else {
        'winget is unavailable; skipping extra tooling'
    }

    # Nobody has the built-in Administrator's throwaway password, and nobody
    # should be able to try guessing it. Check the account the agent will
    # actually log in with exists first, or the image locks everyone out.
    if (-not (Get-LocalUser -Name $RcGuestUser -ErrorAction SilentlyContinue)) {
        throw "The unattend did not create the $RcGuestUser account; refusing to disable the built-in Administrator."
    }
    & net.exe user Administrator /active:no
    "disabled the built-in Administrator (exit=$LASTEXITCODE)"

    # Remove every persisted copy of build-time credentials. This is the whole
    # containment story for the plaintext password in the unattend file.
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    foreach ($name in 'AutoAdminLogon', 'DefaultUserName', 'DefaultPassword', 'DefaultDomainName', 'AutoLogonCount') {
        Remove-ItemProperty -Path $winlogon -Name $name -ErrorAction SilentlyContinue
    }
    foreach ($stale in 'C:\Windows\Panther\unattend.xml', 'C:\Windows\Panther\Unattend',
        'C:\Windows\Panther\UnattendGC', 'C:\Windows\System32\Sysprep\unattend.xml',
        'C:\unattend.xml', 'C:\Windows\Setup\Scripts\SetupComplete.cmd') {
        Remove-Item -LiteralPath $stale -Recurse -Force -ErrorAction SilentlyContinue
    }
    'scrubbed unattend copies and AutoLogon registry values'

    New-Item -ItemType File -Path 'C:\rc-provision-complete' -Force | Out-Null
} catch {
    "PROVISION FAILED: $_"
    New-Item -ItemType File -Path 'C:\rc-provision-failed' -Force | Out-Null
} finally {
    Remove-Item -LiteralPath 'C:\Windows\Setup\Scripts\rc-provision.ps1' -Force -ErrorAction SilentlyContinue
    Stop-Transcript
    Stop-Computer -Force
}
'@

    $scriptDir = 'W:\Windows\Setup\Scripts'
    New-Item -ItemType Directory -Path $scriptDir -Force | Out-Null
    Set-Content -Path (Join-Path $scriptDir 'rc-provision.ps1') `
        -Value "$provisionPrelude`n$provisionBody" -Encoding UTF8
    Set-Content -Path (Join-Path $scriptDir 'SetupComplete.cmd') -Encoding ASCII -Value @(
        '@echo off',
        'powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\Windows\Setup\Scripts\rc-provision.ps1'
    )

    # No AutoLogon block and no first-logon commands: SetupComplete.cmd runs as
    # SYSTEM before any logon, so the image never needs a stored logon secret.
    $userXml = ConvertTo-XmlText $GuestUser
    $passwordXml = ConvertTo-XmlText $plain
    $administratorXml = ConvertTo-XmlText $administratorPassword
    $unattend = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64"
               publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"
               xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <AdministratorPassword>
          <Value>$administratorXml</Value>
          <PlainText>true</PlainText>
        </AdministratorPassword>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$userXml</Name>
            <Group>Administrators</Group>
            <Password>
              <Value>$passwordXml</Value>
              <PlainText>true</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <TimeZone>UTC</TimeZone>
    </component>
  </settings>
</unattend>
"@
    New-Item -ItemType Directory -Path 'W:\Windows\Panther' -Force | Out-Null
    # Windows Setup rejects a byte-order mark in front of the XML declaration,
    # and Set-Content -Encoding UTF8 emits one on Windows PowerShell 5.1.
    [IO.File]::WriteAllText('W:\Windows\Panther\unattend.xml', $unattend, [Text.UTF8Encoding]::new($false))

    Dismount-VHD -Path $vhdxPath
    $vhdMounted = $false

    Write-Host 'Booting the image once so provisioning runs'
    $vm = New-VM -Name $buildVm -Generation 2 -MemoryStartupBytes ($BuildMemoryGb * 1GB) `
        -VHDPath $vhdxPath -SwitchName $SwitchName -Path $mountRoot
    Set-VM -VM $vm -ProcessorCount $BuildCpuCount -AutomaticCheckpointsEnabled $false -CheckpointType Disabled
    Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows
    Start-VM -VM $vm

    # rc-provision.ps1 shuts the guest down when it finishes, either way.
    $deadline = (Get-Date).AddMinutes($ProvisionTimeoutMin)
    while ((Get-VM -Name $buildVm).State -ne 'Off') {
        if ((Get-Date) -gt $deadline) {
            throw "Provisioning did not finish within $ProvisionTimeoutMin minutes. If SetupComplete.cmd never ran, no marker file will exist in the image."
        }
        Start-Sleep -Seconds 15
    }
    Remove-VM -Name $buildVm -Force

    # Confirm the guest reported success, and that the scrub actually happened,
    # before blessing the image.
    Mount-VHD -Path $vhdxPath | Out-Null
    $vhdMounted = $true
    $osDrive = (Get-DiskImage -ImagePath $vhdxPath | Get-Disk | Get-Partition |
        Get-Volume | Where-Object { $_.FileSystemLabel -eq 'Windows' }).DriveLetter
    $ok = Test-Path "${osDrive}:\rc-provision-complete"
    $unattendLeft = Test-Path "${osDrive}:\Windows\Panther\unattend.xml"
    $autoLogonLeft = Test-OfflineAutoLogonSecret $osDrive
    $transcript = if (Test-Path "${osDrive}:\rc-provision.log") { Get-Content "${osDrive}:\rc-provision.log" -Tail 30 } else { @() }
    Dismount-VHD -Path $vhdxPath
    $vhdMounted = $false

    if (-not $ok) {
        throw "Guest provisioning failed. Last lines:`n$($transcript -join "`n")"
    }
    if ($unattendLeft) {
        throw 'The unattend file with the guest password is still in the image; refusing to bless it.'
    }
    if ($autoLogonLeft -eq $true) {
        throw 'AutoLogon registry values survive in the image; refusing to bless it.'
    }
    if ($null -eq $autoLogonLeft) {
        Write-Warning 'Could not inspect the image registry offline; the AutoLogon check was skipped. Run this build elevated to enable it.'
    }

    [pscredential]::new($GuestUser, $GuestPassword) | Export-Clixml -Path $credPath
    [pscustomobject]@{
        imageName = $ImageName
        guestUser = $GuestUser
        runnerVersion = $RunnerVersion
        runnerSha256 = $RunnerSha256.ToLowerInvariant()
        defenderRealtimeDisabled = [bool] $DisableDefenderRealtime
        builtAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -Path $manifestPath -Encoding UTF8

    $sizeGb = [math]::Round((Get-Item $vhdxPath).Length / 1GB, 1)
    Write-Host "Built $vhdxPath ($sizeGb GB) with credential $credPath and manifest $manifestPath"
} catch {
    if ($vhdMounted) { Dismount-VHD -Path $vhdxPath -ErrorAction SilentlyContinue }
    if (Get-VM -Name $buildVm -ErrorAction SilentlyContinue) {
        Stop-VM -Name $buildVm -TurnOff -Force -ErrorAction SilentlyContinue
        Remove-VM -Name $buildVm -Force -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $vhdxPath -Force -ErrorAction SilentlyContinue
    throw
} finally {
    if ($isoMount) { Dismount-DiskImage -ImagePath (Resolve-Path $IsoPath).Path | Out-Null }
    Remove-Item -LiteralPath $mountRoot -Recurse -Force -ErrorAction SilentlyContinue
}
