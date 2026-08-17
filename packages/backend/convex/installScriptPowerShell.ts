import type { AgentRelease } from "./agentRelease";

/**
 * The Windows half of `/install`.
 *
 * A Node is any box a customer owns, and `deploy/infra/agent.ps1` has been onboarding Windows ones
 * for as long as there have been Nodes — with no integrity check at all. Windows cannot run the
 * bash installer, so the same guarantee needs a second body rather than a second flag: same pinned
 * per-target digest, same refusal on mismatch, same pluggable byte source. The role is still a
 * parameter on the script, so this handler also takes nothing from the request.
 *
 * There is no Windows *Worker* path: the bash installer refuses Windows for that role too, because
 * the Action Runner Agent's Windows support is a preview with no supported onboarding path yet.
 */
const POWERSHELL_INSTALL_SCRIPT = String.raw`#Requires -Version 5.1
# EraInfra Node installer for Windows. One command turns a fresh box into a Node: it downloads the
# Infra Agent this deployment pins, verifies its SHA-256 before anything is installed, and registers
# a scheduled task so the agent reconnects after a reboot. The agent dials OUT to the Hub over WSS,
# so the box needs no inbound port and works behind NAT.
#
#   & ([scriptblock]::Create((irm <site>/install.ps1))) -Token <token> -Hub wss://<hub>/agent -Install
#
# -Source points the payload at a hub mirror or a local file for air-gapped installs. It moves where
# the bytes come from, never where this script came from: the digest below arrived over TLS from the
# deployment's own origin, which is what makes an untrusted byte source safe to read.
param(
  [string]$Role = "node",
  [string]$Token = "",
  [string]$Hub = "",
  [string]$Name = "",
  [string]$Source = "",
  [switch]$Install
)
$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Stage 1 of retiring the "Portless" name (ADR 0004; CONTEXT.md rule 4): read both, prefer the new,
# warn on the old, delete nothing. A param default cannot call a function declared below it, so the
# environment fallback for -Token / -Hub lands here rather than in param().
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
if (-not $Token) { $Token = Get-RenamedEnv "ERAINFRA_TOKEN" "PORTLESS_TOKEN" }
if (-not $Hub) { $Hub = Get-RenamedEnv "ERAINFRA_HUB" "PORTLESS_HUB" }

$repo = '__AGENT_REPO__'
$version = '__AGENT_VERSION__'

# Every Infra Agent digest this deployment pins. A target that is not listed is a target this
# installer refuses: there would be nothing to check the bytes against.
$pinned = @{
__INFRA_AGENT_DIGESTS__
}

function Fail($message) {
  Write-Host "[erainfra] $message" -ForegroundColor Red
  exit 1
}

if ($Role -ne "node") {
  Fail "This installer onboards a Node (-Role node). Windows is not a supported Worker platform yet."
}
if (-not $Token) { Fail 'need -Token <hub enrollment token> (or $env:PORTLESS_TOKEN)' }
if (-not $Hub) { Fail 'need -Hub wss://<hub>/agent (or $env:PORTLESS_HUB)' }

if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
  Fail "This deployment publishes no ARM64 Windows Infra Agent; run it on an x64 Windows host."
}
$target = "windows-x86_64"
$asset = "infra-agent-$target.exe"

$expected = $pinned[$target]
if (-not $expected) {
  Fail "This EraInfra deployment pins no Infra Agent build for $target, so there is nothing to verify the download against. Deploy a backend whose AGENT_RELEASE pins a release that publishes it."
}

$url = "https://github.com/$repo/releases/download/v$version/$asset"
$origin = "the release this deployment pins"
if ($Source) {
  if ($Source.EndsWith("/")) { $url = $Source + $asset } else { $url = $Source }
  $origin = $url
}

# $HOME\.portless is an identifier a running Node already holds (rule 4). Prefer the renamed
# directory only when it is ALREADY there; a fresh install still lands on the frozen path.
$prefix = if (Test-Path (Join-Path $HOME ".erainfra")) { Join-Path $HOME ".erainfra" } else { Join-Path $HOME ".portless" }
$bin = Join-Path $prefix "bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$exe = Join-Path $bin "portless-agent.exe"
$staged = Join-Path ([IO.Path]::GetTempPath()) ("infra-agent-staged-" + [IO.Path]::GetRandomFileName() + ".exe")

Write-Host "[erainfra] fetching the Infra Agent $version for $target from $origin ..."
try {
  if ($url -match '^https?://') {
    Invoke-WebRequest -Uri $url -OutFile $staged -UseBasicParsing
  } elseif ($url -match '^file://') {
    Copy-Item -LiteralPath ($url -replace '^file:///?', '') -Destination $staged -Force
  } else {
    Copy-Item -LiteralPath $url -Destination $staged -Force
  }
} catch {
  Fail "Could not read the Infra Agent from $url"
}

$actual = (Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue
  Fail "Infra Agent checksum verification failed: expected $expected but got $actual. Nothing was installed."
}
Write-Host "[erainfra] verified $asset against the checksum pinned by this EraInfra deployment." -ForegroundColor Green

# Only past the verification does anything on this machine change. A mismatch above leaves an
# already-installed agent running on the bytes it was installed with.
Move-Item -LiteralPath $staged -Destination $exe -Force
Unblock-File -LiteralPath $exe   # clear MOTW so it runs without a SmartScreen prompt
Write-Host "[erainfra] installed $exe"

if (-not $Name) { $Name = $env:COMPUTERNAME }
$agentArgs = @("connect", "--hub", $Hub, "--token", $Token, "--name", $Name)

if ($Install) {
  # The scheduled task name is an identifier a running Node already holds, so it keeps the one
  # deploy/infra/agent.ps1 registers. On a UAC-filtered local admin in a non-elevated shell,
  # Register-ScheduledTask is Access Denied — fall back to a per-user Startup entry, which needs no
  # elevation and still survives reboot.
  try {
    $action = New-ScheduledTaskAction -Execute $exe -Argument ($agentArgs -join " ")
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "PortlessAgent" -Action $action -Trigger $trigger -Force -ErrorAction Stop | Out-Null
    Start-ScheduledTask -TaskName "PortlessAgent" -ErrorAction Stop
    Write-Host "[erainfra] installed scheduled task 'PortlessAgent' and started it." -ForegroundColor Green
    Write-Host '[erainfra] remove with: Unregister-ScheduledTask -TaskName PortlessAgent -Confirm:$false'
  } catch {
    Write-Host "[erainfra] scheduled task needs elevation here; using a per-user Startup entry instead." -ForegroundColor Yellow
    $startup = [Environment]::GetFolderPath('Startup')
    $cmd = Join-Path $startup 'portless-agent.cmd'
    Set-Content -Path $cmd -Encoding ASCII -Value ('@start "" "' + $exe + '" ' + ($agentArgs -join ' '))
    Start-Process -FilePath $exe -ArgumentList $agentArgs -WindowStyle Hidden
    Write-Host "[erainfra] installed Startup entry and started the agent (hidden)." -ForegroundColor Green
  }
  Start-Sleep -Seconds 2
  Write-Host "[erainfra] this Node reports to $Hub as $Name."
} else {
  Write-Host "[erainfra] connecting to $Hub ... (Ctrl-C to stop; re-run with -Install to survive reboot)"
  & $exe @agentArgs
}
`;

/**
 * The `$pinned` hashtable entries, one per pinned target.
 *
 * Checked rather than trusted, for the same reason the bash renderer checks: this is interpolated
 * into a script an operator runs with the privileges of whoever ran it. An empty map renders no
 * entries, so an unpinned deployment refuses rather than installing something it cannot verify.
 */
function renderPinnedDigests(infraAgent: AgentRelease["infraAgent"]) {
  return Object.entries(infraAgent)
    .filter(([target]) => target.startsWith("windows-"))
    .map(([target, digest]) => {
      if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(target)) {
        throw new Error(`Infra Agent pin has an unusable target name: ${target}`);
      }
      if (!/^[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`Infra Agent pin for ${target} is not a lowercase SHA-256 digest`);
      }
      return `  "${target}" = "${digest}"`;
    })
    .join("\n");
}

export function renderPowerShellInstallScript(release: AgentRelease) {
  return POWERSHELL_INSTALL_SCRIPT.replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__INFRA_AGENT_DIGESTS__", renderPinnedDigests(release.infraAgent));
}
