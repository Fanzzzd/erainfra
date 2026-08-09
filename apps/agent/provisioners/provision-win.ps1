# One ephemeral Hyper-V VM per job.
#
# The parent VHDX named by $env:IMAGE lives at %RC_HOME%\images\<image>.vhdx and
# is never written to: every job gets its own differencing child disk that is
# deleted with the VM afterwards. The JIT configuration is handed to the guest
# over PowerShell Direct, so the guest needs no inbound network, no WinRM and no
# SSH -- only outbound access to GitHub for the runner itself.
#
# Required in the parent image:
#   - the GitHub Actions runner extracted at C:\actions-runner
#   - a local administrator account whose credentials this script can present
#
# Environment:
#   RUNNER_NAME        (required) also used as the VM name
#   IMAGE              (required) parent VHDX name, without the .vhdx suffix
#   RC_HOME            defaults to %USERPROFILE%\.runner-center
#   IMAGE_USER         guest account, defaults to "runner"
#   IMAGE_PASSWORD     guest password, defaults to the DPAPI credential file
#   VM_CPU_COUNT       defaults to 4
#   VM_MEMORY_GB       defaults to 8
#   VM_SWITCH          defaults to "Default Switch"
#   RC_BOOT_TIMEOUT_S  defaults to 300 (BOOT_TIMEOUT_S is a fallback)
#   RC_JOB_TIMEOUT_S   defaults to 21600 (JOB_TIMEOUT_S is a fallback); on
#                      expiry the VM is destroyed and this exits 124, matching
#                      the macOS and Linux provisioners
#
# Stdin:
#   The opaque one-shot JIT configuration. It is read from stdin rather than an
#   environment variable so it never appears in this host's process listing.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

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

$runnerName = Get-RequiredEnv 'RUNNER_NAME'
$image = Get-RequiredEnv 'IMAGE'

$jitConfig = [Console]::In.ReadToEnd()
if ($null -ne $jitConfig) { $jitConfig = $jitConfig.Trim() }
if ([string]::IsNullOrWhiteSpace($jitConfig)) {
    throw 'Read an empty JIT configuration from stdin.'
}

$rcHome = Get-EnvOrDefault 'RC_HOME' (Join-Path $env:USERPROFILE '.runner-center')
$cpuCount = [int] (Get-EnvOrDefault 'VM_CPU_COUNT' 4)
$memoryGb = [int] (Get-EnvOrDefault 'VM_MEMORY_GB' 8)
$switchName = Get-EnvOrDefault 'VM_SWITCH' 'Default Switch'
$bootTimeout = [int] (Get-EnvOrDefault 'RC_BOOT_TIMEOUT_S' (Get-EnvOrDefault 'BOOT_TIMEOUT_S' 300))
$jobTimeout = [int] (Get-EnvOrDefault 'RC_JOB_TIMEOUT_S' (Get-EnvOrDefault 'JOB_TIMEOUT_S' 21600))

$imageDir = Join-Path $rcHome 'images'
$parentDisk = Join-Path $imageDir "$image.vhdx"
$vmDir = Join-Path (Join-Path $rcHome 'vms') $runnerName
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

$credential = Resolve-GuestCredential
$vm = $null
$session = $null
$job = $null

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

    # -ArgumentList serialises the JIT config over the VM socket, so it never
    # appears in a command line on this host. Inside the guest it goes into
    # ACTIONS_RUNNER_INPUT_JITCONFIG, the only input upstream's Runner.Listener
    # accepts that is not argv. Passing it as a command line argument instead
    # would publish it in the guest's process list for the whole job.
    #
    # The runner's own output is routed through Write-Host so it cannot join the
    # scriptblock's result stream, and $LASTEXITCODE is captured immediately and
    # returned as a single shaped object. Selecting that object by shape is what
    # keeps an unexpected extra output record from being mistaken for the exit
    # code.
    $guestScript = {
        param($Jit)
        $runner = 'C:\actions-runner\run.cmd'
        if (-not (Test-Path -LiteralPath $runner)) {
            Write-Host "The image does not contain $runner"
            return [pscustomobject]@{ RcExitCode = 1 }
        }

        $env:ACTIONS_RUNNER_INPUT_JITCONFIG = $Jit
        $env:ACTIONS_RUNNER_RETURN_VERSION_DEPRECATED_EXIT_CODE = '1'
        try {
            & $runner 2>&1 | ForEach-Object { Write-Host $_ }
            $code = $LASTEXITCODE
            if ($null -eq $code) { $code = 1 }
            return [pscustomobject]@{ RcExitCode = [int] $code }
        } finally {
            $env:ACTIONS_RUNNER_INPUT_JITCONFIG = $null
        }
    }

    $job = Invoke-Command -Session $session -AsJob -ArgumentList $jitConfig -ScriptBlock $guestScript

    if ($null -eq (Wait-Job -Job $job -Timeout $jobTimeout)) {
        Stop-Job -Job $job -ErrorAction SilentlyContinue
        Write-Host "The job exceeded RC_JOB_TIMEOUT_S (${jobTimeout}s); destroying $runnerName."
        exit 124
    }

    $exitRecord = @(Receive-Job -Job $job -ErrorAction SilentlyContinue) |
        Where-Object { $null -ne $_ -and $null -ne $_.PSObject.Properties['RcExitCode'] } |
        Select-Object -Last 1

    if ($null -eq $exitRecord) { exit 1 }
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
}
