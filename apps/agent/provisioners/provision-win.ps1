# One ephemeral Hyper-V VM per job. PREVIEW: see the security notes below.
#
# The parent VHDX named by $env:IMAGE lives at %RC_HOME%\images\<image>.vhdx and
# is never written to: every job gets its own differencing child disk that is
# deleted with the VM afterwards. The JIT configuration is handed to the guest
# over PowerShell Direct, so the guest needs no inbound network, no WinRM and no
# SSH -- only outbound access to GitHub for the runner itself.
#
# Required in the parent image (build-image.ps1 produces one):
#   - the GitHub Actions runner extracted at C:\actions-runner
#   - a local administrator account whose credentials this script can present
#
# Security model:
#   - The JIT registration blob never reaches a command line. On the host it is
#     passed to Invoke-Command through -ArgumentList, which serialises it over
#     the VM socket. In the guest it is materialised as the runner's own config
#     files instead of being handed to run.cmd as a command-line flag, so a
#     workflow step cannot read it back out of the guest process list.
#   - The guest credential comes from a DPAPI-protected file readable only by
#     the account that built the image, which is the account that runs the
#     agent. IMAGE_PASSWORD overrides it for unattended rebuilds and is the only
#     way a password enters this script; it is never logged or put on argv.
#   - Everything the job touches lives on the differencing child disk, which is
#     destroyed in the finally block, by the PowerShell.Exiting handler, or by
#     the orphan reaper on the next run.
#
# NOT VERIFIED ON A WINDOWS HOST. Nothing in this file has been executed against
# real Hyper-V; it is covered only by the static checks in ../tests. Windows
# catalog labels are preview-gated in the control plane for that reason.
#
# Environment:
#   RUNNER_NAME         (required) also used as the VM name
#   JIT_CONFIG          (required) opaque one-shot runner registration
#   IMAGE               (required) parent VHDX name, without the .vhdx suffix
#   RC_HOME             defaults to %USERPROFILE%\.runner-center
#   IMAGE_USER          guest account, defaults to "runner"
#   IMAGE_PASSWORD      guest password, defaults to the DPAPI credential file
#   VM_CPU_COUNT        defaults to 4
#   VM_MEMORY_GB        defaults to 8
#   VM_SWITCH           defaults to "Default Switch"
#   BOOT_TIMEOUT_S      defaults to 300
#   JOB_TIMEOUT_S       defaults to 21600 (GitHub's own per-job ceiling)
#   ORPHAN_MAX_AGE_MIN  defaults to 720; older leftover VM directories are reaped

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Runner root inside the guest. Keep in sync with build-image.ps1.
$RunnerRoot = 'C:\actions-runner'

function Get-RequiredEnv([string] $Name) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "$Name is required"
    }
    return $value
}

function Get-EnvOrDefault([string] $Name, $Default) {
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
    return $value
}

function Get-PositiveIntEnv([string] $Name, [int] $Default) {
    $raw = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
    $parsed = 0
    if (-not [int]::TryParse($raw.Trim(), [ref] $parsed) -or $parsed -le 0) {
        throw "$Name must be a positive integer, got '$raw'."
    }
    return $parsed
}

# The runner name becomes a VM name and a directory name, so refuse anything
# that could escape the vms directory or confuse Hyper-V.
function Assert-SafeName([string] $Value, [string] $Label) {
    if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$') {
        throw "$Label '$Value' must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$."
    }
}

# Leftovers from a run whose host process was killed outright: the VM directory
# survives, and with it a differencing child disk pinning the parent VHDX. Reap
# anything older than the age limit whose VM is gone, and tear down VMs that are
# themselves that stale. The limit is deliberately longer than GitHub's six-hour
# job ceiling so a live job is never reaped out from under itself.
function Remove-RcOrphan([string] $VmRoot, [int] $MaxAgeMinutes) {
    $reaped = @()
    if (-not (Test-Path -LiteralPath $VmRoot)) { return $reaped }

    $cutoff = (Get-Date).AddMinutes(-$MaxAgeMinutes)
    foreach ($dir in @(Get-ChildItem -LiteralPath $VmRoot -Directory -ErrorAction SilentlyContinue)) {
        $files = @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -ErrorAction SilentlyContinue)
        $lastWrite = (@($dir) + $files | Measure-Object -Property LastWriteTime -Maximum).Maximum
        if ($null -ne $lastWrite -and $lastWrite -gt $cutoff) { continue }

        if (Get-VM -Name $dir.Name -ErrorAction SilentlyContinue) {
            Stop-VM -Name $dir.Name -TurnOff -Force -ErrorAction SilentlyContinue
            Remove-VM -Name $dir.Name -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $dir.FullName)) { $reaped += $dir.Name }
    }
    return $reaped
}

$runnerName = Get-RequiredEnv 'RUNNER_NAME'
$jitConfig = Get-RequiredEnv 'JIT_CONFIG'
$image = Get-RequiredEnv 'IMAGE'
Assert-SafeName $runnerName 'RUNNER_NAME'
Assert-SafeName $image 'IMAGE'

$rcHome = Get-EnvOrDefault 'RC_HOME' (Join-Path $env:USERPROFILE '.runner-center')
$cpuCount = Get-PositiveIntEnv 'VM_CPU_COUNT' 4
$memoryGb = Get-PositiveIntEnv 'VM_MEMORY_GB' 8
$switchName = Get-EnvOrDefault 'VM_SWITCH' 'Default Switch'
$bootTimeout = Get-PositiveIntEnv 'BOOT_TIMEOUT_S' 300
$jobTimeout = Get-PositiveIntEnv 'JOB_TIMEOUT_S' 21600
$orphanMaxAgeMin = Get-PositiveIntEnv 'ORPHAN_MAX_AGE_MIN' 720

$imageDir = Join-Path $rcHome 'images'
$parentDisk = Join-Path $imageDir "$image.vhdx"
$vmRoot = Join-Path $rcHome 'vms'
$vmDir = Join-Path $vmRoot $runnerName
$childDisk = Join-Path $vmDir "$runnerName.vhdx"

if (-not (Get-Command Get-VM -ErrorAction SilentlyContinue)) {
    throw 'The Hyper-V PowerShell module is unavailable. Enable the Microsoft-Hyper-V-All feature and reboot.'
}
if (-not (Test-Path -LiteralPath $parentDisk)) {
    throw "Parent image $parentDisk not found. Build it before assigning $image jobs to this machine."
}
if (-not (Get-VMSwitch -Name $switchName -ErrorAction SilentlyContinue)) {
    throw "Hyper-V switch '$switchName' not found. The guest needs outbound network access to reach GitHub."
}

$orphans = @(Remove-RcOrphan $vmRoot $orphanMaxAgeMin)
if ($orphans.Count -gt 0) {
    Write-Host "Reaped orphaned runner VMs: $($orphans -join ', ')"
}

# DPAPI-protected credential written at image build time, overridable by env for
# unattended rebuilds. Never put the password on a command line.
function Resolve-GuestCredential {
    $user = [Environment]::GetEnvironmentVariable('IMAGE_USER')
    $password = [Environment]::GetEnvironmentVariable('IMAGE_PASSWORD')
    if (-not [string]::IsNullOrWhiteSpace($password)) {
        if ([string]::IsNullOrWhiteSpace($user)) { $user = 'runner' }
        return [pscredential]::new($user, (ConvertTo-SecureString $password -AsPlainText -Force))
    }

    $credentialPath = Join-Path $imageDir "$image.cred.xml"
    if (-not (Test-Path -LiteralPath $credentialPath)) {
        throw "No guest credential for $image. Set IMAGE_PASSWORD or create $credentialPath with Export-Clixml."
    }
    return Import-Clixml -LiteralPath $credentialPath
}

# Runs inside the guest. Everything it needs arrives through -ArgumentList, so
# no secret is ever rendered into a command line on either side of the socket.
$guestScript = {
    param([string] $Jit, [string] $RunnerRoot)

    # A native runner exit code is not an error condition here; let the pipeline
    # finish so the exit code can be reported instead of throwing.
    $ErrorActionPreference = 'Continue'

    $runner = Join-Path $RunnerRoot 'run.cmd'
    if (-not (Test-Path -LiteralPath $runner)) {
        Write-Host "The image does not contain $runner"
        return [pscustomobject]@{ RcExitCode = 1 }
    }

    # Mirrors actions/runner v2.336.0 src/Runner.Listener/Runner.cs: the blob is
    # base64(UTF-8 JSON) mapping a runner-root file name to base64 content, and
    # on Windows .credentials_rsaparams is DPAPI-protected at LocalMachine scope
    # before it is written. Writing these files ourselves is what keeps the
    # registration off run.cmd's command line. Re-check this against the runner
    # source whenever the pinned runner version moves.
    try {
        $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Jit))
        $files = @{}
        foreach ($property in (ConvertFrom-Json $decoded).PSObject.Properties) {
            $files[$property.Name] = [string] $property.Value
        }
    } catch {
        Write-Host "Could not decode the JIT configuration: $($_.Exception.Message)"
        return [pscustomobject]@{ RcExitCode = 1 }
    }
    if ($files.Count -eq 0) {
        Write-Host 'The JIT configuration decoded to no runner config files.'
        return [pscustomobject]@{ RcExitCode = 1 }
    }

    Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
    try {
        foreach ($name in $files.Keys) {
            # The blob is trusted input from the control plane, but it decides
            # file names: refuse anything that is not a runner dotfile.
            if ($name -notmatch '^\.[A-Za-z0-9_]{1,64}$') {
                throw "Refusing to write unexpected runner config file '$name'."
            }
            $bytes = [Convert]::FromBase64String($files[$name])
            if ($name -eq '.credentials_rsaparams') {
                $bytes = [Security.Cryptography.ProtectedData]::Protect(
                    $bytes, $null, [Security.Cryptography.DataProtectionScope]::LocalMachine)
            }
            $path = Join-Path $RunnerRoot $name
            [IO.File]::WriteAllBytes($path, $bytes)
            (Get-Item -LiteralPath $path -Force).Attributes = 'Hidden'
        }
    } catch {
        Write-Host "Could not install the JIT configuration: $($_.Exception.Message)"
        return [pscustomobject]@{ RcExitCode = 1 }
    }

    # Route runner output to the host stream so it is displayed but stays out of
    # the returned object collection, leaving one unambiguous exit-code record.
    & $runner 2>&1 | ForEach-Object { Write-Host $_ }
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 1 }
    return [pscustomobject]@{ RcExitCode = [int] $code }
}

$credential = Resolve-GuestCredential
$vm = $null
$session = $null
$job = $null

# The finally block covers throws and normal exits; this covers a graceful
# engine shutdown that unwinds past it. A hard kill is covered by the orphan
# reaper at the start of the next run.
$global:RcCleanupVmName = $runnerName
$global:RcCleanupVmDir = $vmDir
$null = Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action {
    if ($global:RcCleanupVmName) {
        if (Get-VM -Name $global:RcCleanupVmName -ErrorAction SilentlyContinue) {
            Stop-VM -Name $global:RcCleanupVmName -TurnOff -Force -ErrorAction SilentlyContinue
            Remove-VM -Name $global:RcCleanupVmName -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $global:RcCleanupVmDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

try {
    if (Get-VM -Name $runnerName -ErrorAction SilentlyContinue) {
        throw "A VM named $runnerName already exists; refusing to reuse it."
    }

    New-Item -ItemType Directory -Path $vmDir -Force | Out-Null
    New-VHD -Path $childDisk -ParentPath $parentDisk -Differencing | Out-Null

    $vm = New-VM -Name $runnerName -Generation 2 -MemoryStartupBytes ($memoryGb * 1GB) `
        -VHDPath $childDisk -SwitchName $switchName -Path $vmDir
    Set-VM -VM $vm -ProcessorCount $cpuCount -AutomaticCheckpointsEnabled $false `
        -CheckpointType Disabled -AutomaticStopAction TurnOff
    # The parent was captured from a Generation 2 guest, so keep Secure Boot on
    # with the Microsoft Windows template it was sealed under.
    Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows

    Start-VM -VM $vm

    $deadline = (Get-Date).AddSeconds($bootTimeout)
    while ($null -eq $session) {
        if ((Get-Date) -gt $deadline) {
            throw "Timed out after ${bootTimeout}s waiting for PowerShell Direct on $runnerName."
        }
        if ((Get-VM -Name $runnerName).State -ne 'Running') {
            throw "VM $runnerName stopped before PowerShell Direct became available."
        }
        $session = New-PSSession -VMName $runnerName -Credential $credential -ErrorAction SilentlyContinue
        if ($null -eq $session) { Start-Sleep -Seconds 3 }
    }

    Write-Host "Guest $runnerName is up; starting the ephemeral runner."

    # As a job so a wedged runner hits a deadline instead of hanging the agent
    # slot forever. Output is drained as it arrives so logs are not withheld
    # until the runner exits.
    $job = Invoke-Command -Session $session -AsJob -ArgumentList $jitConfig, $RunnerRoot -ScriptBlock $guestScript
    $jobDeadline = (Get-Date).AddSeconds($jobTimeout)
    $returned = @()
    while ($true) {
        $chunk = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
        if ($chunk.Count -gt 0) { $returned += $chunk }
        if ($job.State -ne 'Running' -and $job.State -ne 'NotStarted') { break }
        if ((Get-Date) -gt $jobDeadline) {
            throw "Timed out after ${jobTimeout}s waiting for the runner on $runnerName to exit."
        }
        Start-Sleep -Seconds 5
    }
    $chunk = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    if ($chunk.Count -gt 0) { $returned += $chunk }

    # `& run.cmd` writes to the pipeline as well, so pick the exit-code record
    # out by shape rather than assuming it is the only thing that came back.
    $exitRecord = $returned |
        Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['RcExitCode'] } |
        Select-Object -Last 1
    if ($null -eq $exitRecord) {
        throw "The guest on $runnerName returned no runner exit code."
    }
    exit [int] $exitRecord.RcExitCode
} finally {
    if ($null -ne $job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $session) {
        Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    }
    if (Get-VM -Name $runnerName -ErrorAction SilentlyContinue) {
        Stop-VM -Name $runnerName -TurnOff -Force -ErrorAction SilentlyContinue
        Remove-VM -Name $runnerName -Force -ErrorAction SilentlyContinue
    }
    # Removing the VM leaves the differencing child behind; the parent is untouched.
    Remove-Item -LiteralPath $vmDir -Recurse -Force -ErrorAction SilentlyContinue
    $global:RcCleanupVmName = $null
    Unregister-Event -SourceIdentifier PowerShell.Exiting -ErrorAction SilentlyContinue
}
