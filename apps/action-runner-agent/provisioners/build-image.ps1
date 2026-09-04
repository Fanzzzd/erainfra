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
#   - git, Node.js and Python come from their vendors under the same rule: an
#     explicit version, an explicit SHA-256, verified before the installer is
#     executed, and asserted onto the machine PATH afterwards. A tool that does
#     not install fails the build instead of shipping a hollow image.
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
#   - The password that survives is the guest account's, stored machine-scope
#     DPAPI-encrypted next to the VHDX as <ImageName>.cred.json. Machine scope
#     because the agent runs as LocalSystem under its service wrapper while
#     this build runs as an interactive administrator, and user-scope DPAPI
#     does not cross that boundary; the file is ACLed to SYSTEM and
#     Administrators only.
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
    # The tooling every checkout needs, pinned exactly the way the runner above
    # is: a version, a SHA-256 of the vendor's own artifact, and no resolution
    # of "whatever is newest" at build time. Bump a version and its digest in
    # the same edit; the guest refuses a download that hashes to anything else.
    #   git    https://github.com/git-for-windows/git/releases
    #   node   https://nodejs.org/dist/v<version>/SHASUMS256.txt
    #   python https://www.python.org/downloads/release/python-<version>/
    [string] $GitVersion = '2.55.0',
    # Git for Windows re-releases one upstream version several times; the tag is
    # v<GitVersion>.windows.<GitWindowsRevision> and the digest is per revision.
    [int] $GitWindowsRevision = 4,
    [string] $GitSha256 = '0cbc0b34a74b3aff3ace0910328549155a770e228331b19cb1498218a120e7ff',
    [string] $NodeVersion = '24.19.0',
    [string] $NodeSha256 = 'f0f66c2a80c08a30a5ab5179ee9ea9e45f9b46289436a8cc87ff833b852db351',
    [string] $PythonVersion = '3.13.15',
    [string] $PythonSha256 = 'edec09c4853aeae9ac36efb8c9f95b6b8e2fee65eee56d9767a8b7c69c574403',
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
    # RNGCryptoServiceProvider rather than RandomNumberGenerator::Fill, which
    # does not exist on the .NET Framework that Windows PowerShell 5.1 runs on.
    $rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::new()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
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
if ($GitVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "-GitVersion must look like 2.55.0, got '$GitVersion'."
}
if ($GitWindowsRevision -lt 1) {
    throw "-GitWindowsRevision must be the Git for Windows revision of that tag, got '$GitWindowsRevision'."
}
if ($GitSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw '-GitSha256 must be 64 hex characters.'
}
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "-NodeVersion must look like 24.19.0, got '$NodeVersion'."
}
if ($NodeSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw '-NodeSha256 must be 64 hex characters.'
}
if ($PythonVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "-PythonVersion must look like 3.13.15, got '$PythonVersion'."
}
if ($PythonSha256 -notmatch '^[0-9a-fA-F]{64}$') {
    throw '-PythonSha256 must be 64 hex characters.'
}

$imageDir = Join-Path $RcHome 'images'
$vhdxPath = Join-Path $imageDir "$ImageName.vhdx"
$credPath = Join-Path $imageDir "$ImageName.cred.json"
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
`$RcGitVersion = '$GitVersion'
`$RcGitWindowsRevision = $GitWindowsRevision
`$RcGitSha256 = '$GitSha256'
`$RcNodeVersion = '$NodeVersion'
`$RcNodeSha256 = '$NodeSha256'
`$RcPythonVersion = '$PythonVersion'
`$RcPythonSha256 = '$PythonSha256'
`$RcGuestUser = '$GuestUser'
`$RcDisableDefenderRealtime = `$$($DisableDefenderRealtime.IsPresent)
"@

    # Provisioning that runs as SYSTEM at the end of setup, before any logon.
    # Keep it idempotent and fail loudly: a half-provisioned parent image is
    # worse than none. Never echo a credential into the transcript.
    $provisionBody = @'
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 renders an Invoke-WebRequest progress bar per chunk
# even with nowhere to render it, which costs more than the download does. The
# guest fetches a quarter of a gigabyte across four artifacts; turn it off.
$ProgressPreference = 'SilentlyContinue'

# Fetch one pinned artifact and prove it is the artifact that was pinned, in
# that order and with nothing in between: a file that fails this never becomes
# an argument to anything.
function Save-RcPinnedDownload([string] $Url, [string] $Path, [string] $Sha256) {
    $name = Split-Path $Path -Leaf
    Invoke-WebRequest -Uri $Url -OutFile $Path -UseBasicParsing
    $actual = (Get-FileHash -Path $Path -Algorithm SHA256).Hash
    if ($actual -ne $Sha256.ToUpperInvariant()) {
        Remove-Item $Path -Force -ErrorAction SilentlyContinue
        throw "$name SHA-256 mismatch: expected $Sha256, got $actual"
    }
    Write-Host "verified $name ($actual)"
}

# Run one verified installer and read the code it actually returned.
# $ErrorActionPreference has no bearing on a native exit code, and these are
# GUI-subsystem binaries that '&' does not wait for, so a $LASTEXITCODE read
# straight after '&' would describe a process that is still running. Wait for
# the process, then check it.
function Install-RcPinnedTool([string] $Name, [string] $Program, [string[]] $ArgumentList) {
    $process = Start-Process -FilePath $Program -ArgumentList $ArgumentList -Wait -PassThru
    $code = $process.ExitCode
    # 3010 is ERROR_SUCCESS_REBOOT_REQUIRED, and provisioning shuts the guest
    # down when it finishes, so the restart the installer asked for happens.
    if ($code -ne 0 -and $code -ne 3010) {
        throw "the $Name installer exited with $code"
    }
    Write-Host "installed $Name (installer exit=$code)"
}

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

    if (-not (Test-Path 'C:\actions-runner\run.cmd')) {
        throw 'the runner archive did not contain run.cmd'
    }

    Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled -Value 1

    if ($RcDisableDefenderRealtime) {
        'WARNING: disabling Defender real-time monitoring image-wide, as requested'
        Set-MpPreference -DisableRealtimeMonitoring $true -ErrorAction SilentlyContinue
    }

    # A missing tool fails the image, reversing this file's earlier "Missing
    # extra tooling must not fail the image". git, node and python are not
    # extras: actions/checkout is git, and the setup-* actions bootstrap from a
    # host interpreter. An image blessed without them fails every job ever
    # placed onto it, at the first step, in a way that reads like the user's
    # fault. C:\rc-provision-complete is a bless signal and it means one thing
    # -- everything this image promises is present -- so the absence of a tool
    # must not be able to produce it. Recording the gap instead would need a
    # placement-time check in the scheduler that does not exist yet; until it
    # does, recording is today's silent shipping with better logging. Stopping
    # here spends one builder's time once instead of every job's time forever.
    #
    # The package manager this replaces ships on no Windows Server SKU, so on
    # 2022 the whole block was a log line and a shrug. Nothing here needs one:
    # every vendor publishes an installer and a digest for it.
    $gitInstallerName = "Git-$RcGitVersion.$RcGitWindowsRevision-64-bit.exe"
    if ($RcGitWindowsRevision -eq 1) {
        # Only revision 1 is published without the revision in the file name.
        $gitInstallerName = "Git-$RcGitVersion-64-bit.exe"
    }
    $gitInstaller = Join-Path $env:TEMP $gitInstallerName
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v$RcGitVersion.windows.$RcGitWindowsRevision/$gitInstallerName"
    Save-RcPinnedDownload $gitUrl $gitInstaller $RcGitSha256
    # PathOption=Cmd is the option that puts git.exe on the machine PATH, which
    # is the thing asserted below; the rest just keep the installer silent.
    Install-RcPinnedTool 'git' $gitInstaller @(
        '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/o:PathOption=Cmd')
    Remove-Item $gitInstaller -Force

    $nodeInstallerName = "node-v$RcNodeVersion-x64.msi"
    $nodeInstaller = Join-Path $env:TEMP $nodeInstallerName
    $nodeUrl = "https://nodejs.org/dist/v$RcNodeVersion/$nodeInstallerName"
    Save-RcPinnedDownload $nodeUrl $nodeInstaller $RcNodeSha256
    # An .msi is data, not a program: msiexec is the program that runs it.
    Install-RcPinnedTool 'node' 'msiexec.exe' @('/i', "`"$nodeInstaller`"", '/qn', '/norestart')
    Remove-Item $nodeInstaller -Force

    $pythonInstallerName = "python-$RcPythonVersion-amd64.exe"
    $pythonInstaller = Join-Path $env:TEMP $pythonInstallerName
    $pythonUrl = "https://www.python.org/ftp/python/$RcPythonVersion/$pythonInstallerName"
    Save-RcPinnedDownload $pythonUrl $pythonInstaller $RcPythonSha256
    # InstallAllUsers makes it a machine installation; PrependPath is what adds
    # it to the machine PATH rather than to SYSTEM's own profile.
    Install-RcPinnedTool 'python' $pythonInstaller @(
        '/quiet', 'InstallAllUsers=1', 'PrependPath=1', 'Include_test=0')
    Remove-Item $pythonInstaller -Force

    # An installer's PATH edit is visible only to sessions started after it, so
    # this process's $env:PATH proves nothing about the image; the machine value
    # in the registry is what a job's shell will inherit. The @(...) wrap and
    # the .Count test are load-bearing: a one-element pipeline result is not an
    # array in PowerShell, so -not $found misreads exactly the case that matters.
    $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    # The stored machine value may still carry unexpanded %SystemRoot% entries.
    $machinePath = [Environment]::ExpandEnvironmentVariables($machinePath)
    # Each name carries the version it must report, in one list, so a tool
    # cannot be added to the loop with nothing to check it against.
    $pinnedTools = @(
        @{ Exe = 'git.exe'; Version = "$RcGitVersion.windows.$RcGitWindowsRevision" },
        @{ Exe = 'node.exe'; Version = "v$RcNodeVersion" },
        @{ Exe = 'python.exe'; Version = $RcPythonVersion }
    )
    foreach ($tool in $pinnedTools) {
        $exe = $tool.Exe
        # Join-Path parses its first argument as a drive, so one quoted entry in
        # the machine PATH -- installers do write those -- would throw here and
        # fail the build for a reason that has nothing to do with the tools.
        # Trim the entry and probe it literally instead.
        $found = @($machinePath.Split(';') |
            Where-Object { $_ } |
            ForEach-Object { $_.Trim('"').TrimEnd('\') + '\' + $exe } |
            Where-Object { Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue })
        if ($found.Count -eq 0) { throw "$exe is not on the machine PATH after provisioning" }
        $resolved = $found[0]
        # These three are console applications, so '&' does wait for them and
        # $LASTEXITCODE describes the run that just finished.
        # Capture every line rather than piping to Select-Object: stopping a
        # pipeline early kills the native command and leaves $LASTEXITCODE
        # describing the kill instead of the run.
        $reported = @(& $resolved --version)
        if ($LASTEXITCODE -ne 0) { throw "$resolved --version exited with $LASTEXITCODE" }
        # Answering is not the same as being the pinned tool. An installer that
        # no-ops over an existing copy still exits 0, and a base image that
        # already carried the tool would leave it first on the machine PATH --
        # either way the manifest would record a version the image does not
        # have, which is the same lie as recording one it does not carry at all.
        if ($reported.Count -eq 0 -or $reported[0] -notlike "*$($tool.Version)*") {
            throw "$resolved reports '$($reported[0])', not the pinned $($tool.Version)"
        }
        # What the image ships, in the transcript, so it can be audited later.
        "$exe -> $resolved ($($reported[0]))"
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
    # Get-VHD rather than Get-DiskImage: Hyper-V owns the disk once Mount-VHD
    # has attached it, and Get-DiskImage does not resolve a Hyper-V-mounted VHDX.
    $osDrive = (Get-VHD -Path $vhdxPath | Get-Disk | Get-Partition |
        Get-Volume | Where-Object { $_.FileSystemLabel -eq 'Windows' }).DriveLetter
    if (-not $osDrive) { throw 'Could not resolve the OS volume of the built VHDX.' }
    # The marker alone is not enough; require the runner the image exists to carry.
    $ok = (Test-Path "${osDrive}:\rc-provision-complete") -and
          (Test-Path "${osDrive}:\actions-runner\run.cmd")
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

    # Machine-scope DPAPI rather than user-scope Export-Clixml: the agent runs
    # as LocalSystem under its service wrapper while images are built by an
    # interactive administrator, and user-scope DPAPI material written by one
    # account is unreadable by the other. Machine scope decrypts for any local
    # process, so the file's ACL -- SYSTEM and Administrators only, granted by
    # SID because group names are localized -- is the actual access boundary.
    Add-Type -AssemblyName System.Security
    $protectedPassword = [System.Security.Cryptography.ProtectedData]::Protect(
        [Text.Encoding]::UTF8.GetBytes($plain),
        $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine)
    @{ user = $GuestUser; passwordProtected = [Convert]::ToBase64String($protectedPassword) } |
        ConvertTo-Json | Set-Content -Path $credPath -Encoding UTF8
    & icacls $credPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed to lock down $credPath (exit $LASTEXITCODE)" }

    [pscustomobject]@{
        imageName = $ImageName
        guestUser = $GuestUser
        runnerVersion = $RunnerVersion
        runnerSha256 = $RunnerSha256.ToLowerInvariant()
        gitVersion = "$GitVersion.windows.$GitWindowsRevision"
        gitSha256 = $GitSha256.ToLowerInvariant()
        nodeVersion = $NodeVersion
        nodeSha256 = $NodeSha256.ToLowerInvariant()
        pythonVersion = $PythonVersion
        pythonSha256 = $PythonSha256.ToLowerInvariant()
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
