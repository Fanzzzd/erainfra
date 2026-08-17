# Portless agent — one line to bring a Windows box onto the mesh as a deploy node.
# The agent dials OUT to the hub over WSS (no inbound port, works behind NAT).
#
#   & ([scriptblock]::Create((irm <hub>/agent.ps1))) -Token <token> [-Name <name>] -Install
#   & ([scriptblock]::Create((irm <hub>/agent.ps1))) -Token <token> -Install -SetupRuntime
#
# What this script no longer does (ADR 0006): download an .exe and run it. It used to fetch
# $hostBase/agent-bin/portless-agent-windows-amd64.exe with no integrity check of any kind and start
# it. It now hands the install to the control plane's verified installer at /install.ps1, which
# checks what it downloaded against a SHA-256 the control plane pins and refuses on a mismatch.
#
# The bytes still come from this hub by default — -Source points the payload at /agent-bin/ while the
# script and the digest come from the control plane over TLS — so self-hosted and air-gapped installs
# are unaffected. Populate the mirror with build-agents.sh from the commit the control plane pins.
#
# The hub URL defaults to wherever this script was served from, so usually just -Token is needed.
# -Install     registers a scheduled task so the agent reconnects at every logon (survives reboot).
# -SetupRuntime (elevated) best-effort enables the Windows Linux-container stack (WSL2 features). It
#               never reboots on its own — it tells you when a reboot is needed. Without it the script
#               only INSTALLS the agent and REPORTS what the box still needs to run containers.
# -InstallUrl  the control plane serving /install.ps1; defaults to $env:ERAINFRA_INSTALL_URL.
# -FromRelease take the bytes from the GitHub release instead of this hub's mirror.
param(
  [string]$Hub = "",
  [string]$Token = "",
  [string]$Name = "",
  [string]$InstallUrl = "",
  [switch]$FromRelease,
  [switch]$Install,
  [switch]$SetupRuntime
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# --- retiring the "Portless" name, stage 1 (ADR 0004; CONTEXT.md rule 4) -----------------------
# Read both names, prefer the new one, warn when the old one is what was found, delete nothing.
# Copied rather than shared: this file is irm'd and run as a scriptblock on a bare box. See
# apps/hub/src/env.ts for the reasons.
function Get-RenamedEnv {
  param([string]$NewName, [string]$OldName)
  $current = [Environment]::GetEnvironmentVariable($NewName)
  if ($null -ne $current -and $current -ne "") { return $current }
  $retired = [Environment]::GetEnvironmentVariable($OldName)
  if ($null -ne $retired -and $retired -ne "") {
    Write-Host "[erainfra] $OldName is a retired name - use $NewName instead. The old name still works." -ForegroundColor Yellow
    return $retired
  }
  return $null
}

# A param default cannot call a function defined below it, so the env fallback lands here instead.
if (-not $Token) { $Token = Get-RenamedEnv "ERAINFRA_TOKEN" "PORTLESS_TOKEN" }

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

if ($SetupRuntime) { Enable-Runtime }

# The server templates <install> to the control plane this hub is configured against
# (ERAINFRA_INSTALL_URL), and to the empty string when there is none — which is why the placeholder
# appears exactly once and nothing below compares against its text: the templating would rewrite
# that comparison too. Without a control plane there is no pinned digest, and installing an
# unchecked binary is exactly what ADR 0006 retired, so this refuses rather than falling back.
$templatedInstallUrl = "<install>"
$resolvedInstallUrl = $InstallUrl
if (-not $resolvedInstallUrl) { $resolvedInstallUrl = $env:ERAINFRA_INSTALL_URL }
if (-not $resolvedInstallUrl) { $resolvedInstallUrl = $templatedInstallUrl }
if (-not $resolvedInstallUrl) {
  throw "no verified installer configured: set ERAINFRA_INSTALL_URL on the hub, or pass -InstallUrl https://<control-plane>"
}

# Self-hosted by default: the payload comes off this hub, the digest comes from the control plane.
# Windows agent is amd64 (the common case). For arm64 Windows, build+serve that asset and adjust.
$installerArgs = @{ Role = "node"; Token = $Token; Hub = $wss; Install = [bool]$Install }
if ($Name) { $installerArgs.Name = $Name }
if (-not $FromRelease) { $installerArgs.Source = "$hostBase/agent-bin/portless-agent-windows-amd64.exe" }

Write-Host "[portless] installing the verified agent via $resolvedInstallUrl/install.ps1 ..."
try {
  & ([scriptblock]::Create((Invoke-RestMethod -Uri "$resolvedInstallUrl/install.ps1" -UseBasicParsing))) @installerArgs
} catch {
  Write-Host "[portless] verified install failed. If the checksum did not match, this hub's /agent-bin mirror is not the release the control plane pins: rebuild it with build-agents.sh from that commit, or re-run with -FromRelease." -ForegroundColor Red
  throw
}

Show-Runtime | Out-Null
