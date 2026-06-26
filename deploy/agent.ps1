# Portless agent — one line to bring a Windows box onto the mesh as a deploy node.
# The agent dials OUT to the hub over WSS (no inbound port, works behind NAT).
#
#   & ([scriptblock]::Create((irm <hub>/agent.ps1))) -Token <token> [-Name <name>]
#   & ([scriptblock]::Create((irm <hub>/agent.ps1))) -Hub wss://hub.example.com/agent -Token <token>
#
# The hub URL defaults to wherever this script was served from, so usually just -Token is needed.
# -Install registers a scheduled task so the agent reconnects at every logon (survives reboot);
# without it the agent just runs in this window.
param(
  [string]$Hub = "",
  [string]$Token = $env:PORTLESS_TOKEN,
  [string]$Name = "",
  [switch]$Install
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

$agentArgs = @("connect", "--hub", $wss, "--token", $Token)
if ($Name) { $agentArgs += @("--name", $Name) }

if ($Install) {
  # Reconnect at every logon (survives reboot). Runs as the current user — no admin token needed.
  $action = New-ScheduledTaskAction -Execute $exe -Argument ($agentArgs -join " ")
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  Register-ScheduledTask -TaskName "PortlessAgent" -Action $action -Trigger $trigger -Force | Out-Null
  Start-ScheduledTask -TaskName "PortlessAgent"
  Write-Host "[portless] installed scheduled task 'PortlessAgent' and started it. Remove with: Unregister-ScheduledTask -TaskName PortlessAgent -Confirm:`$false"
} else {
  Write-Host "[portless] connecting to $wss ... (Ctrl-C to stop)"
  & $exe @agentArgs
}
