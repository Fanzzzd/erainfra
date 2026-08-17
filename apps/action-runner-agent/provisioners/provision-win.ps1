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
#     the VM socket. In the guest it is handed to Runner.Listener through
#     ACTIONS_RUNNER_INPUT_JITCONFIG instead of argv or a provisioner-owned
#     config file. Runner.Listener clears that variable after consuming it, but
#     another process running as the same guest user could inspect its environment
#     during that brief window.
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
#   IMAGE               (required) parent VHDX name, without the .vhdx suffix
#   RC_HOME             defaults to %USERPROFILE%\.runner-center
#   IMAGE_USER          guest account, defaults to "runner"
#   IMAGE_PASSWORD      guest password, defaults to the DPAPI credential file
#   VM_CPU_COUNT        defaults to 4
#   VM_MEMORY_GB        defaults to 8
#   VM_SWITCH           defaults to "Default Switch"
#   RC_BOOT_TIMEOUT_S   defaults to 300; seconds to boot and accept PowerShell
#                       Direct. Legacy fallback: BOOT_TIMEOUT_S.
#   RC_JOB_TIMEOUT_S    defaults to 21600 (GitHub's own per-job ceiling); seconds
#                       the runner may take before the VM is destroyed and this
#                       exits 124, the same as the macOS and Linux provisioners.
#                       Legacy fallback: JOB_TIMEOUT_S.
#   ORPHAN_MAX_AGE_MIN  defaults to 720; older leftover VM directories are reaped
#
# Stdin:
#   The opaque one-shot JIT configuration, base64 as GitHub issues it. It is read
#   from stdin rather than an environment variable so it never appears in this
#   host's process listing.

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

# Every provisioner reads the same RC_-prefixed budget, in seconds. The per-OS
# spelling stays honoured so an agent configured before the names were unified
# keeps working.
function Get-TimeoutEnv([string] $Name, [string] $LegacyName, [int] $Default) {
    $legacy = Get-PositiveIntEnv $LegacyName $Default
    return Get-PositiveIntEnv $Name $legacy
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
$image = Get-RequiredEnv 'IMAGE'
Assert-SafeName $runnerName 'RUNNER_NAME'
Assert-SafeName $image 'IMAGE'

$jitConfig = [Console]::In.ReadToEnd()
if ($null -ne $jitConfig) { $jitConfig = $jitConfig.Trim() }
if ([string]::IsNullOrWhiteSpace($jitConfig)) {
    throw 'Read an empty JIT configuration from stdin.'
}
if ($jitConfig -notmatch '^[A-Za-z0-9+/=]+$') {
    throw 'The JIT configuration read from stdin is not base64. Pipe the value of encoded_jit_config verbatim.'
}

$rcHome = Get-EnvOrDefault 'RC_HOME' (Join-Path $env:USERPROFILE '.runner-center')
$cpuCount = Get-PositiveIntEnv 'VM_CPU_COUNT' 4
$memoryGb = Get-PositiveIntEnv 'VM_MEMORY_GB' 8
$switchName = Get-EnvOrDefault 'VM_SWITCH' 'Default Switch'
$bootTimeout = Get-TimeoutEnv 'RC_BOOT_TIMEOUT_S' 'BOOT_TIMEOUT_S' 300
$jobTimeout = Get-TimeoutEnv 'RC_JOB_TIMEOUT_S' 'JOB_TIMEOUT_S' 21600
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

    # Not run.cmd: it and run-helper.cmd exist to drive a long-lived service, so
    # they map "listener exited with a terminated error" onto exit 0 -- stop, do
    # not retry. For a one-shot ephemeral runner that turns every startup
    # failure into a reported success. Call the listener directly and let its
    # own exit code stand.
    $runner = Join-Path $RunnerRoot 'bin\Runner.Listener.exe'
    if (-not (Test-Path -LiteralPath $runner)) {
        Write-Host "The image does not contain $runner"
        return [pscustomobject]@{ RcExitCode = 1 }
    }

    # ACTIONS_RUNNER_INPUT_JITCONFIG is the one input upstream's Runner.Listener
    # accepts that is not argv: src/Runner.Listener/CommandSettings.cs consumes
    # any ACTIONS_RUNNER_INPUT_* variable, clears it from its own environment,
    # and — because `jitconfig` is in Constants.Runner.CommandLine.Args.Secrets —
    # registers the value with the secret masker. Passing it as an argument
    # instead would publish the registration in the guest's process list for the
    # whole job, and unpacking it into the runner's own config files here would
    # duplicate logic that belongs to the runner and has to be re-checked against
    # its source on every version bump.
    $env:ACTIONS_RUNNER_INPUT_JITCONFIG = $Jit
    # Surface a runner GitHub has deprecated as exit 7 instead of a silent 0.
    $env:ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE = '1'
    try {
        # Route runner output to the host stream so it is displayed but stays out
        # of the returned object collection, leaving one unambiguous exit-code
        # record. $LASTEXITCODE is captured immediately, before the finally block
        # below can run anything that would overwrite it.
        & $runner run 2>&1 | ForEach-Object { Write-Host $_ }
        $code = $LASTEXITCODE
        if ($null -eq $code) { $code = 1 }
        return [pscustomobject]@{ RcExitCode = [int] $code }
    } finally {
        $env:ACTIONS_RUNNER_INPUT_JITCONFIG = $null
    }
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
            # Use 124 consistently across provisioners so the agent log identifies
            # a timeout; the backend applies its normal bounded retry policy. The
            # finally block destroys the VM.
            Write-Host "The job exceeded RC_JOB_TIMEOUT_S (${jobTimeout}s); destroying $runnerName."
            exit 124
        }
        Start-Sleep -Seconds 5
    }
    $chunk = @(Receive-Job -Job $job -ErrorAction SilentlyContinue)
    if ($chunk.Count -gt 0) { $returned += $chunk }

    # The runner writes to the pipeline as well, so pick the exit-code record
    # out by shape rather than assuming it is the only thing that came back.
    $exitRecord = $returned |
        Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['RcExitCode'] } |
        Select-Object -Last 1
    if ($null -eq $exitRecord) {
        throw "The guest on $runnerName returned no runner exit code."
    }
    exit [int] $exitRecord.RcExitCode
} finally {
    # The VM goes first. Stop-Job blocks until the job has actually stopped, and
    # a job running over PowerShell Direct into a wedged guest can make that
    # wait indefinite -- which would leave the VM, its differencing disk and the
    # Profile slot behind, precisely when teardown matters most. Stop-VM
    # -TurnOff is a power cut and asks the guest for nothing, so nothing that
    # can block belongs in front of it. The job and the session are torn down
    # afterwards, against a guest that no longer exists, so they fail fast.
    if (Get-VM -Name $runnerName -ErrorAction SilentlyContinue) {
        Stop-VM -Name $runnerName -TurnOff -Force -ErrorAction SilentlyContinue
        Remove-VM -Name $runnerName -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $job) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $session) {
        Remove-PSSession -Session $session -ErrorAction SilentlyContinue
    }
    # Removing the VM leaves the differencing child behind; the parent is untouched.
    Remove-Item -LiteralPath $vmDir -Recurse -Force -ErrorAction SilentlyContinue
    $global:RcCleanupVmName = $null
    Unregister-Event -SourceIdentifier PowerShell.Exiting -ErrorAction SilentlyContinue
}
