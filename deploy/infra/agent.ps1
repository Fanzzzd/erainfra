# Portless agent — one line to bring a Windows box onto the mesh as a deploy node.
# The agent dials OUT to the hub over WSS (no inbound port, works behind NAT).
#
#   & ([scriptblock]::Create((irm <hub>/agent.ps1))) -Token <token> [-Name <name>] -Install
#   & ([scriptblock]::Create((irm <hub>/agent.ps1))) -Token <token> -Install -SetupRuntime
#
# The hub URL defaults to wherever this script was served from, so usually just -Token is needed.
# -Install     registers a scheduled task so the agent reconnects at every logon (survives reboot).
# -SetupRuntime (elevated) best-effort enables the Windows Linux-container stack (WSL2 features). It
#               never reboots on its own — it tells you when a reboot is needed. Without it the script
#               only INSTALLS the agent and REPORTS what the box still needs to run containers.
param(
  [string]$Hub = "",
  [string]$Token = $env:PORTLESS_TOKEN,
  [string]$Name = "",
  [switch]$Install,
  [switch]$SetupRuntime
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# <hub> is templated by the server to the base URL this script was served from.
$servedFrom = "<hub>"
if (-not $Token) { throw "need -Token <token> (or `$env:PORTLESS_TOKEN)" }

# Resolve hub: -Hub wins; else where this script came from. Normalize to http base + wss/agent url.
$raw = if ($Hub) { $Hub } else { $servedFrom }
if ($raw -match '^(wss?)://') {
  $wss = $raw
  $httpBase = $raw -replace '^ws', 'http'
} else {
  $httpBase = $raw
  $wss = ($raw -replace '^http', 'ws')
}
# bare scheme://host (drop any path like /agent.ps1 or /agent)
$hostBase = [regex]::Match($httpBase, '^[a-z]+://[^/]+').Value
if ($raw -notmatch '^(wss?)://') { $wss = ($hostBase -replace '^http', 'ws') + '/agent' }

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

# Report the container-runtime situation and the exact next step. Returns $true if ready to deploy.
function Show-Runtime {
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker -and (& docker info 2>$null)) {
    Write-Host "[portless] container runtime READY: $((docker --version) 2>$null)" -ForegroundColor Green
    return $true
  }
  Write-Host "[portless] container runtime NOT ready on this box:" -ForegroundColor Yellow
  $hv  = (Get-CimInstance Win32_ComputerSystem).HypervisorPresent
  $vmp = (Get-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -ErrorAction SilentlyContinue).State
  $wsl = (Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux -ErrorAction SilentlyContinue).State
  Write-Host ("    docker installed     : {0}" -f $(if ($docker) {'yes'} else {'NO'}))
  Write-Host ("    HypervisorPresent    : {0}" -f $hv)
  Write-Host ("    VirtualMachinePlatform: {0}" -f $vmp)
  Write-Host ("    WSL feature          : {0}" -f $wsl)
  Write-Host "    Flight & friends are Linux containers, which on Windows need a working WSL2 backend."
  if (-not $SetupRuntime) {
    Write-Host "    -> re-run with -SetupRuntime (as Administrator) to enable the stack." -ForegroundColor Cyan
  }
  return $false
}

# Best-effort enable the Linux-container stack. Enables features (no reboot), updates the WSL2 kernel.
# Docker Desktop install is intentionally NOT automated (GUI/MSI + license + AV friction) — once WSL2
# works, install Docker once by hand, then deploys flow through the already-running agent.
function Enable-Runtime {
  if (-not (Test-Admin)) { Write-Host "[portless] -SetupRuntime needs an elevated PowerShell (Run as administrator)." -ForegroundColor Red; return }
  Write-Host "[portless] enabling VirtualMachinePlatform + WSL features (no reboot)…"
  & dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart | Out-Null
  & dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart | Out-Null
  Write-Host "[portless] updating the WSL2 kernel…"
  & wsl.exe --update 2>&1 | Write-Host
  Write-Host "[portless] features enabled. REBOOT, then run: wsl --install -d Ubuntu  (and install Docker)." -ForegroundColor Cyan
  Write-Host "[portless] if 'wsl --install' still fails at CreateVm/HCS/E_INVALIDARG after reboot, the host's" -ForegroundColor Yellow
  Write-Host "           nested-virtualization is off — enable it on the hypervisor/BIOS hosting this box." -ForegroundColor Yellow
}

$prefix = Join-Path $HOME ".portless"
$bin = Join-Path $prefix "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$exe = Join-Path $bin "portless-agent.exe"

# Windows agent is amd64 (the common case). For arm64 Windows, build+serve that asset and adjust.
$arch = "amd64"
$url = "$hostBase/agent-bin/portless-agent-windows-$arch.exe"
Write-Host "[portless] downloading agent from $url ..."
Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
Unblock-File $exe   # clear MOTW so it runs without a SmartScreen prompt

if ($SetupRuntime) { Enable-Runtime }

$agentArgs = @("connect", "--hub", $wss, "--token", $Token)
if ($Name) { $agentArgs += @("--name", $Name) }

if ($Install) {
  # Prefer a scheduled task (runs even before interactive logon). On a UAC-filtered local admin in a
  # non-elevated shell, Register-ScheduledTask is Access Denied — so fall back to a per-user Startup
  # entry, which needs NO elevation and still survives reboot (runs at the next interactive logon).
  try {
    $action = New-ScheduledTaskAction -Execute $exe -Argument ($agentArgs -join " ")
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "PortlessAgent" -Action $action -Trigger $trigger -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName "PortlessAgent" -ErrorAction Stop
    Write-Host "[portless] installed scheduled task 'PortlessAgent' and started it." -ForegroundColor Green
    Write-Host "[portless] remove with: Unregister-ScheduledTask -TaskName PortlessAgent -Confirm:`$false"
  } catch {
    Write-Host "[portless] scheduled task needs elevation here; using a per-user Startup entry instead (no admin needed)." -ForegroundColor Yellow
    $startup = [Environment]::GetFolderPath('Startup')
    $cmd = Join-Path $startup 'portless-agent.cmd'
    Set-Content -Path $cmd -Encoding ASCII -Value ('@start "" "' + $exe + '" ' + ($agentArgs -join ' '))
    Start-Process -FilePath $exe -ArgumentList $agentArgs -WindowStyle Hidden
    Write-Host "[portless] installed Startup entry and started the agent (hidden)." -ForegroundColor Green
    Write-Host "[portless] remove with: del `"$cmd`""
  }
  Start-Sleep -Seconds 2
  Show-Runtime | Out-Null
} else {
  Show-Runtime | Out-Null
  Write-Host "[portless] connecting to $wss ... (Ctrl-C to stop)"
  & $exe @agentArgs
}
