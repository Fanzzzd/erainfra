<#
  Portless mesh node bootstrap for Windows (PowerShell) — the native equivalent of the curl|sh one.
  Joins a Windows box to the mesh over iroh: no public IP, no account, no build tools (downloads a
  prebuilt dumbpipe.exe).

    # run a command, e.g. expose this box's RDP (3389) on the mesh:
    & ([scriptblock]::Create((irm <hub>/mesh-node.ps1))) share 3389
    # dial a ticket onto a local port (transparent TCP):
    & ([scriptblock]::Create((irm <hub>/mesh-node.ps1))) connect <ticket> 13389
    # also: status | stop <name> | install

  `share 3389` makes this box's Remote Desktop reachable from any other box that runs
  `connect <ticket> 13389`, with no changes and no public IP. Identity is stable across restarts
  (a per-link iroh secret is persisted). Windows children outlive the launching shell, so the link
  keeps running after this returns; for reboot-survival, register it as a Scheduled Task (see -Persist note).
#>
param(
  [string]$Command = 'help',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # GitHub needs TLS1.2+

$DumbpipeVersion = if ($env:DUMBPIPE_VERSION) { $env:DUMBPIPE_VERSION } else { 'v0.39.0' }
$Prefix = if ($env:PORTLESS_PREFIX) { $env:PORTLESS_PREFIX } else { Join-Path $env:USERPROFILE '.portless' }
$Bin   = Join-Path $Prefix 'bin'
$State = if ($env:PORTLESS_STATE_DIR) { $env:PORTLESS_STATE_DIR } else { Join-Path $Prefix 'mesh' }
$Run   = Join-Path $Prefix 'run'
$SelfUrl = if ($env:PORTLESS_SELF_URL) { $env:PORTLESS_SELF_URL } else { '<hub>/mesh-node.ps1' }
$Dumbpipe = Join-Path $Bin 'dumbpipe.exe'

function Log  { param($m) Write-Host "[portless] $m" -ForegroundColor Cyan }
function Die  { param($m) Write-Host "[portless] $m" -ForegroundColor Red; exit 1 }

function Install-Dumbpipe {
  if (Test-Path $Dumbpipe) { return }
  if ([Environment]::Is64BitOperatingSystem -eq $false) { Die "need 64-bit Windows" }
  New-Item -ItemType Directory -Force -Path $Bin | Out-Null
  # dumbpipe ships a windows-x86_64 build only; Windows Server is x86_64 in practice.
  $url = "https://github.com/n0-computer/dumbpipe/releases/download/$DumbpipeVersion/dumbpipe-$DumbpipeVersion-windows-x86_64.zip"
  $tmp = Join-Path $env:TEMP ("dp-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  Log "downloading dumbpipe $DumbpipeVersion ..."
  try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile (Join-Path $tmp 'dp.zip') } catch { Die "download failed: $url" }
  Expand-Archive -Path (Join-Path $tmp 'dp.zip') -DestinationPath $tmp -Force
  $exe = Get-ChildItem -Path $tmp -Recurse -Filter 'dumbpipe.exe' | Select-Object -First 1
  if (-not $exe) { Die "dumbpipe.exe not found in archive" }
  Copy-Item $exe.FullName $Dumbpipe -Force
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Log "installed dumbpipe -> $Dumbpipe"
}

# Stable iroh identity per link name: 32 random bytes hex, persisted. Same name -> same NodeId.
function Get-Secret { param($name)
  $f = Join-Path $State "$name.key"
  if (-not (Test-Path $f)) {
    New-Item -ItemType Directory -Force -Path $State | Out-Null
    $bytes = New-Object byte[] 32
    ([System.Security.Cryptography.RNGCryptoServiceProvider]::new()).GetBytes($bytes)
    (($bytes | ForEach-Object { $_.ToString('x2') }) -join '') | Set-Content -NoNewline -Path $f
  }
  (Get-Content -Raw $f).Trim()
}

function Start-Link { param($name, [string[]]$dpArgs)
  New-Item -ItemType Directory -Force -Path $Run | Out-Null
  $pidf = Join-Path $Run "$name.pid"
  $logf = Join-Path $Run "$name.log"
  if ((Test-Path $pidf) -and (Get-Process -Id (Get-Content $pidf) -ErrorAction SilentlyContinue)) {
    Die "a link named '$name' is already running (stop it: ... stop $name)"
  }
  '' | Set-Content $logf
  # -NoNewWindow allows stderr redirect (dumbpipe prints the ticket there); the child outlives this
  # shell on Windows (no parent-kill), so the link persists after we return.
  $p = Start-Process -FilePath $Dumbpipe -ArgumentList $dpArgs -NoNewWindow -PassThru -RedirectStandardError $logf
  $p.Id | Set-Content -NoNewline $pidf
  Log "started '$name' (pid $($p.Id), log: $logf)"
}

function Wait-Ticket { param($name)
  $logf = Join-Path $Run "$name.log"
  for ($i = 0; $i -lt 100; $i++) {
    if (Test-Path $logf) {
      $m = [regex]::Match((Get-Content -Raw $logf), 'endpoint[a-z2-7]{40,}')
      if ($m.Success) { return $m.Value }
    }
    Start-Sleep -Milliseconds 200
  }
  return $null
}

function Wait-Port { param($port)
  for ($i = 0; $i -lt 80; $i++) {
    if (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) { return $true }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

function Cmd-Share { param($port, $name)
  if (-not $port) { Die "usage: ... share <port> [name]" }
  if (-not $name) { $name = "share-$port" }
  Install-Dumbpipe
  $env:IROH_SECRET = Get-Secret $name     # stable NodeId; inherited by the child
  Start-Link $name @('listen-tcp', '--host', "127.0.0.1:$port")
  $ticket = Wait-Ticket $name
  if (-not $ticket) { Get-Content (Join-Path $Run "$name.log") -Tail 5 | Write-Host; Die "timed out waiting for the mesh ticket" }
  $env:IROH_SECRET = $null
  Write-Host ""
  Write-Host "OK sharing 127.0.0.1:$port on the mesh (link: $name)" -ForegroundColor Green
  Write-Host "   On the OTHER box, run:"
  Write-Host "     curl -fsSL $($SelfUrl -replace '\.ps1$','.sh') | sh -s -- connect $ticket <local-port>"
  Write-Output $ticket   # ticket on the pipeline so it's captureable
}

function Cmd-Connect { param($ticket, $port, $name)
  if (-not $ticket -or -not $port) { Die "usage: ... connect <ticket> <local-port> [name]" }
  if (-not $name) { $name = "connect-$port" }
  Install-Dumbpipe
  $env:IROH_SECRET = $null                 # dialer: ephemeral identity
  Start-Link $name @('connect-tcp', '--addr', "127.0.0.1:$port", $ticket)
  Start-Sleep -Seconds 1
  $pidf = Join-Path $Run "$name.pid"
  if (-not (Get-Process -Id (Get-Content $pidf) -ErrorAction SilentlyContinue)) {
    Get-Content (Join-Path $Run "$name.log") -Tail 5 | Write-Host; Die "link exited immediately (bad ticket?)"
  }
  Log "dialing remote..."
  if (Wait-Port $port) {
    Write-Host ""
    Write-Host "OK connected - remote service is now at 127.0.0.1:$port (link: $name)" -ForegroundColor Green
  } else {
    Write-Host "link up - 127.0.0.1:$port will accept within a few seconds (check: ... status)" -ForegroundColor Green
  }
}

function Cmd-Status {
  if (-not (Test-Path $Run)) { Log "no mesh links"; return }
  $any = $false
  Get-ChildItem -Path $Run -Filter '*.pid' | ForEach-Object {
    $name = $_.BaseName; $procId = Get-Content $_.FullName
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) { "  {0,-20} pid {1,-7} up" -f $name, $procId | Write-Host; $any = $true }
    else { "  {0,-20} (dead)" -f $name | Write-Host }
  }
  if (-not $any) { Log "no live mesh links" }
}

function Cmd-Stop { param($name)
  if (-not $name) { Die "usage: ... stop <name>" }
  $pidf = Join-Path $Run "$name.pid"
  if (-not (Test-Path $pidf)) { Die "no such link: $name" }
  Stop-Process -Id (Get-Content $pidf) -Force -ErrorAction SilentlyContinue
  Remove-Item $pidf -Force
  Log "stopped '$name'"
}

switch ($Command) {
  'install' { Install-Dumbpipe; Log "ready: $Dumbpipe" }
  'share'   { Cmd-Share   $Rest[0] $Rest[1] }
  'connect' { Cmd-Connect $Rest[0] $Rest[1] $Rest[2] }
  'status'  { Cmd-Status }
  'stop'    { Cmd-Stop    $Rest[0] }
  default {
    @"
portless mesh node (Windows) - link this box over iroh, no public IP, no account.

  share <port> [name]             expose a local service (e.g. RDP 3389), print a ticket
  connect <ticket> <port> [name]  dial a ticket onto a local port (transparent TCP)
  status                          list local mesh links
  stop <name>                     tear a link down
  install                         just download dumbpipe.exe
"@ | Write-Host
  }
}
