# Build a Runner Center parent VHDX from a Windows installation ISO.
#
# Applies the chosen edition straight out of install.wim with DISM instead of
# running a full interactive setup, seeds an unattend.xml that creates the guest
# account and provisions the Actions runner on first logon, then boots the VM
# once so that specialize and first-logon actually run. The VM is discarded
# afterwards; only the VHDX is kept, and provision-win.ps1 never writes to it.
#
# Usage:
#   .\build-image.ps1 -IsoPath ~\.runner-center\iso\ws2025-eval.iso -ImageName rc-win2025
#
# The guest password is generated unless -GuestPassword is supplied, and is
# stored DPAPI-encrypted next to the VHDX as <ImageName>.cred.xml, readable only
# by the account that ran this build -- the same account that runs the agent.

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
    [int] $ProvisionTimeoutMin = 60
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$imageDir = Join-Path $RcHome 'images'
$vhdxPath = Join-Path $imageDir "$ImageName.vhdx"
$credPath = Join-Path $imageDir "$ImageName.cred.xml"
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
    # 24 chars from a set with no shell- or XML-hostile characters.
    $alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_'
    $bytes = [byte[]]::new(24)
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $plain = -join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })
    $GuestPassword = ConvertTo-SecureString $plain -AsPlainText -Force
} else {
    $plain = [System.Net.NetworkCredential]::new('', $GuestPassword).Password
}

$isoMount = $null
$vhdMounted = $false

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

    # Provisioning that runs inside the guest on first logon. Keep it idempotent
    # and fail loudly: a half-provisioned parent image is worse than none.
    $provision = @'
$ErrorActionPreference = 'Stop'
$log = 'C:\rc-provision.log'
Start-Transcript -Path $log -Append
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $runnerDir = 'C:\actions-runner'
    New-Item -ItemType Directory -Path $runnerDir -Force | Out-Null
    $release = Invoke-RestMethod 'https://api.github.com/repos/actions/runner/releases/latest' -Headers @{ 'User-Agent' = 'runner-center' }
    $version = $release.tag_name.TrimStart('v')
    $url = "https://github.com/actions/runner/releases/download/v$version/actions-runner-win-x64-$version.zip"
    $zip = Join-Path $env:TEMP "actions-runner-$version.zip"
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $runnerDir -Force
    Remove-Item $zip -Force
    "installed actions runner $version"

    # Long paths and developer-friendly defaults the hosted images also set.
    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1
    Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue

    foreach ($pkg in @('Git.Git', 'OpenJS.NodeJS.LTS', 'Python.Python.3.12')) {
        winget install --id $pkg --silent --accept-source-agreements --accept-package-agreements --scope machine
        "winget $pkg exit=$LASTEXITCODE"
    }
    New-Item -ItemType File -Path 'C:\rc-provision-complete' -Force | Out-Null
} catch {
    "PROVISION FAILED: $_"
    New-Item -ItemType File -Path 'C:\rc-provision-failed' -Force | Out-Null
} finally {
    Stop-Transcript
    Stop-Computer -Force
}
'@
    New-Item -ItemType Directory -Path 'W:\Windows\Setup\Scripts' -Force | Out-Null
    Set-Content -Path 'W:\rc-provision.ps1' -Value $provision -Encoding UTF8

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
          <Value>$plain</Value>
          <PlainText>true</PlainText>
        </AdministratorPassword>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>$GuestUser</Name>
            <Group>Administrators</Group>
            <Password>
              <Value>$plain</Value>
              <PlainText>true</PlainText>
            </Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Username>$GuestUser</Username>
        <Enabled>true</Enabled>
        <LogonCount>1</LogonCount>
        <Password>
          <Value>$plain</Value>
          <PlainText>true</PlainText>
        </Password>
      </AutoLogon>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <CommandLine>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\rc-provision.ps1</CommandLine>
          <Description>Runner Center provisioning</Description>
        </SynchronousCommand>
      </FirstLogonCommands>
      <TimeZone>UTC</TimeZone>
    </component>
  </settings>
</unattend>
"@
    New-Item -ItemType Directory -Path 'W:\Windows\Panther' -Force | Out-Null
    Set-Content -Path 'W:\Windows\Panther\unattend.xml' -Value $unattend -Encoding UTF8

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
            throw "Provisioning did not finish within $ProvisionTimeoutMin minutes."
        }
        Start-Sleep -Seconds 15
    }
    Remove-VM -Name $buildVm -Force

    # Confirm the guest reported success before blessing the image.
    Mount-VHD -Path $vhdxPath | Out-Null
    $vhdMounted = $true
    $osDrive = (Get-DiskImage -ImagePath $vhdxPath | Get-Disk | Get-Partition |
        Get-Volume | Where-Object { $_.FileSystemLabel -eq 'Windows' }).DriveLetter
    $ok = Test-Path "${osDrive}:\rc-provision-complete"
    $transcript = if (Test-Path "${osDrive}:\rc-provision.log") { Get-Content "${osDrive}:\rc-provision.log" -Tail 30 } else { @() }
    Dismount-VHD -Path $vhdxPath
    $vhdMounted = $false
    if (-not $ok) {
        throw "Guest provisioning failed. Last lines:`n$($transcript -join "`n")"
    }

    [pscredential]::new($GuestUser, $GuestPassword) | Export-Clixml -Path $credPath
    $sizeGb = [math]::Round((Get-Item $vhdxPath).Length / 1GB, 1)
    Write-Host "Built $vhdxPath ($sizeGb GB) with credential $credPath"
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
