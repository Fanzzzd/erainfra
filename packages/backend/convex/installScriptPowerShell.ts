import type { AgentRelease } from "./agentRelease";

/**
 * `/install.ps1` — the Windows installer, both roles.
 *
 * This module has served the Node role since the Infra Agent moved onto a pinned download. #49 adds
 * the Worker role to it rather than beside it: ADR 0006 is one onboarding path with the role as a
 * parameter, and a second script per role is the shape that ADR retired. It stays one file for a
 * second, harder reason — PowerShell allows exactly one `param()` block per script, so two roles
 * served from one URL have to share one, and two modules could not have composed into one body.
 *
 * This is the PowerShell counterpart of `installScript.ts`, and it mirrors that file's supply chain
 * rather than inventing a second one: the archive named by this deployment's `AGENT_RELEASE`, the
 * digest published beside it, and — the part that actually matters — the digest this deployment
 * pins, which is a trust root outside the release. An archive the release vouches for but the pin
 * does not is refused. `#49`'s design reference reached GitHub over an unpinned branch tarball and
 * then ran `npm install && npm run build` on the customer's machine; none of that is here.
 *
 * One file for both roles, the way `installScript.ts` is one file for both roles: a shared preamble,
 * the Worker body, the `-Role` dispatch, then the Node body that `installScriptPowerShell.ts` held
 * on its own until this landed. Two files could not have composed — PowerShell allows exactly one
 * `param()` block per script, and the two roles have to share it.
 *
 * Nothing in the Worker body has been executed on Windows. See `installScriptPowerShell.test.ts`
 * for what the suite does and does not prove.
 */

/**
 * The Node body's `param()` entries — the ones only `-Role node` reads. The Worker refuses them,
 * the same way bash hands each role only its own flags.
 */
const POWERSHELL_NODE_PARAMS = [
  '  [string]$Hub = "",',
  '  [string]$Source = "",',
  "  [switch]$Install,",
] as const;

/**
 * The Node installer, from the release pin down — the body this module shipped before #49, kept as
 * close to unchanged as sharing one script with a second role allows. Three deltas, each forced:
 *
 * 1. `param()`, `$ErrorActionPreference`, the TLS line, `Get-RenamedEnv` and `Fail` moved up into
 *    the shared preamble. PowerShell allows exactly one `param()` block per script, so two roles in
 *    one script have to share it, and the dispatch needs `Fail` declared above it.
 * 2. `$version` became `$releaseVersion`. PowerShell variable names are case-insensitive, so with
 *    `-Version` in the shared block a bare `$version` here IS that parameter, and this body would
 *    silently overwrite an argument the operator passed.
 * 3. The `-Role` refusal became the dispatch below it.
 * 4. One em dash in a comment became a hyphen. The rendered script has to stay pure ASCII: Windows
 *    PowerShell 5.1 reads a BOM-less file as ANSI, and this one is fetched over HTTP and built with
 *    `[scriptblock]::Create`, so there is no BOM to read.
 *
 * `$repo` keeps its name because nothing collides with it, and the digest comparison keeps its own
 * `Get-FileHash` rather than borrowing the Worker's helper: this path is shipped and working, and
 * consolidating it would be a change to it for no benefit the Node role receives.
 */
const POWERSHELL_NODE_BODY = String.raw`$repo = '__AGENT_REPO__'
$releaseVersion = '__AGENT_VERSION__'

# Every Infra Agent digest this deployment pins. A target that is not listed is a target this
# installer refuses: there would be nothing to check the bytes against.
$pinned = @{
__INFRA_AGENT_DIGESTS__
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

$url = "https://github.com/$repo/releases/download/v$releaseVersion/$asset"
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

Write-Host "[erainfra] fetching the Infra Agent $releaseVersion for $target from $origin ..."
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
  # Detect and report, never rename (ADR 0004 stage 1). A scheduled task is not a path a fallback
  # can chase: registering a second task under a new name leaves the old one REGISTERED and starting
  # its own agent at every logon, so the box would run two. This guard lived in deploy/infra/agent.ps1
  # next to the registration; the registration moved here, so the guard moves with it - nothing in
  # this release can produce the half-migrated state, but a hand-migrated box can.
  $renamedTask = Get-ScheduledTask -TaskName "EraInfraAgent" -ErrorAction SilentlyContinue
  $frozenTask = Get-ScheduledTask -TaskName "PortlessAgent" -ErrorAction SilentlyContinue
  if ($renamedTask -and $frozenTask) {
    Fail 'this box has both PortlessAgent and EraInfraAgent scheduled tasks - two agents would dial the same hub. Unregister one first: Unregister-ScheduledTask -TaskName EraInfraAgent -Confirm:$false'
  }
  # The scheduled task name is an identifier a running Node already holds, so it keeps the one
  # deploy/infra/agent.ps1 registers. On a UAC-filtered local admin in a non-elevated shell,
  # Register-ScheduledTask is Access Denied - fall back to a per-user Startup entry, which needs no
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
const WINDOWS_INSTALL_SCRIPT = String.raw`#Requires -Version 5.1
# The EraInfra installer for Windows. One URL, two roles, the same way /install is one bash file
# with a --role dispatch at the top:
#
#   Worker - executes CI jobs, runs the Action Runner Agent:
#     & ([scriptblock]::Create((irm <site>/install.ps1))) -Role worker -Token rcreg_xxx
#   Node - runs deployed Apps, runs the Infra Agent:
#     & ([scriptblock]::Create((irm <site>/install.ps1))) -Token <token> -Hub wss://<hub>/agent -Install
#
# -Role defaults to "node" where the bash installer defaults to "worker". That asymmetry is
# deliberate: this URL has served the Node installer since the Infra Agent moved onto a pinned
# download, and install commands already in operators' hands omit the flag entirely. The role that
# arrives second is the role that names itself.
param(
  [string]$Role = "node",
  [string]$Token = "",
  [string]$Name = "",
__NODE_PARAMS__
  [string]$Labels = "",
  [string]$Slots = "",
  [switch]$Update,
  [string]$Version = "",
  [string]$Sha256 = ""
)
$ErrorActionPreference = "Stop"
# $PSBoundParameters is per-scope: inside a function it describes that function's own call, not the
# script's. Each role checks which flags the OPERATOR actually passed, so the script's own set is
# captured here, once, where it is still in scope.
$invokedParameters = @($PSBoundParameters.Keys)
# Invoke-WebRequest on Windows PowerShell 5.1 draws a progress bar that costs more wall-clock than
# the transfer it is describing. Silencing it is worth an order of magnitude on a release archive.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Fail($message) {
  Write-Host "[erainfra] $message" -ForegroundColor Red
  exit 1
}
function Say($message) { Write-Host "[erainfra] $message" -ForegroundColor Green }
function Warn($message) { Write-Host "[erainfra] $message" -ForegroundColor Yellow }

# $ErrorActionPreference has no opinion whatsoever about a native program's exit code: tar.exe,
# icacls.exe and the service commands can fail and a script with -ErrorAction Stop set will carry
# happily on with whatever they left behind. #48 documents exactly that biting the image builder.
# Every native call in this file goes through here, so a non-zero $LASTEXITCODE stops the install
# instead of being printed and ignored. stderr is deliberately NOT redirected: 2>&1 on a native
# command under -ErrorAction Stop turns any stderr line into a terminating NativeCommandError, so
# a tool that warns on the way to success would abort the install.
function Invoke-Native {
  param([string]$Exe, [string[]]$CommandArgs, [string]$What)
  & $Exe @CommandArgs
  if ($LASTEXITCODE -ne 0) { Fail "$What failed (exit $LASTEXITCODE); nothing further was changed." }
}

# One hashing implementation for every byte this script verifies, so there is exactly one place a
# comparison could be written wrongly, and it is the same one for the Node binary, the Worker
# archive, the Node.js runtime and the service wrapper.
function Get-Sha256($path) {
  return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
}

# Fetch, then verify, then hand back the path - never the other way round, and never a partial
# result. A caller that gets a path from this function is holding bytes that matched.
function Get-VerifiedDownload {
  param([string]$Uri, [string]$Destination, [string]$Expected, [string]$What)
  if (-not $Expected) { Fail "Refusing to install $What with no expected checksum to compare against." }
  try {
    if ($Uri -match '^https?://') {
      Invoke-WebRequest -Uri $Uri -OutFile $Destination -UseBasicParsing
    } elseif ($Uri -match '^file://') {
      Copy-Item -LiteralPath ($Uri -replace '^file:///?', '') -Destination $Destination -Force
    } else {
      Copy-Item -LiteralPath $Uri -Destination $Destination -Force
    }
  } catch {
    Fail "Could not download $What from $Uri"
  }
  $actual = Get-Sha256 $Destination
  if ($actual -ne $Expected) {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    Fail "$What checksum verification failed: expected $Expected but got $actual. Nothing was installed."
  }
  return $Destination
}

# Stage 1 of retiring the "Portless" name (ADR 0004; CONTEXT.md rule 4): read both, prefer the new,
# warn on the old, delete nothing. A param default cannot call a function declared below it, so the
# environment fallback for -Token / -Hub lands below rather than in param().
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

# A Windows-only API that answers conservatively when it is unavailable: an empty SID grants one
# fewer principal, which cannot widen access. Safe to swallow here; it would not be in a
# verification path.
function Get-CurrentUserSid {
  try { return ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value } catch { return "" }
}

# The POSIX installer writes the machine token with umask 077. NTFS has no umask, so the equivalent
# is explicit: break inheritance, then grant a closed set. SIDs, never account names - the built-in
# groups are localised ("Administrateurs" on a French install) and a grant by name silently does not
# apply. The agent runs as the installing user, so that account's own SID is the one that must be
# able to read .env; SYSTEM and Administrators are here because they can read it regardless and
# leaving them out only breaks backup and repair.
function Protect-Path($path) {
  $sid = Get-CurrentUserSid
  $grants = @('*S-1-5-18:(OI)(CI)(F)', '*S-1-5-32-544:(OI)(CI)(F)')
  if ($sid) { $grants += "*$sid" + ':(OI)(CI)(F)' }
  $arguments = @($path, '/inheritance:r', '/q', '/grant:r') + $grants
  Invoke-Native -Exe 'icacls.exe' -CommandArgs $arguments -What "Locking down $path"
}

function Install-Worker {
  $siteUrl = '__ERAINFRA_SITE_URL__'
  $agentRepo = '__AGENT_REPO__'
  $pinnedVersion = '__AGENT_VERSION__'
  $pinnedSha256 = '__AGENT_SHA256__'

  # %USERPROFILE%\.runner-center, NOT %ProgramData%\RunnerCenter as #49's design reference had it.
  # That reference predates the Hyper-V provisioner landing on main: provisioners/build-image.ps1
  # and provisioners/provision-win.ps1 BOTH default RC_HOME to %USERPROFILE%\.runner-center, and
  # %RC_HOME%\images\<name>.vhdx is where the builder writes the parent disks the provisioner
  # clones. An installer that lands anywhere else points the agent at an images directory nothing
  # fills. It is also the exact mirror of $HOME/.runner-center, which is what the POSIX installer
  # uses, so one layout describes a Worker on all three platforms.
  $rcHome = Join-Path $env:USERPROFILE '.runner-center'
  $agentDir = Join-Path $rcHome 'agent'
  $previousDir = Join-Path $rcHome 'agent.previous'
  $binDir = Join-Path $rcHome 'bin'
  $envFile = Join-Path $agentDir '.env'
  $metaFile = Join-Path $rcHome 'install-meta'
  $logFile = Join-Path $rcHome 'agent.log'
  $readyFile = Join-Path $rcHome 'agent.ready'
  $startScript = Join-Path $rcHome 'start-agent.ps1'
  $rcCli = Join-Path $binDir 'rc.ps1'
  # A new identifier, and frozen the day it ships, so it is named under the current rules rather
  # than the retiring runner-center-* ones (CONTEXT.md rule 2 calls those legacy, not precedent).
  # Qualified by the surface it serves, because rule 1 says "agent" alone is never a name here: this
  # is the Action Runner Agent's task, and a box can be a Node too, whose task is PortlessAgent.
  $taskName = 'erainfra-action-runner-agent'

  function Show-Usage {
    Write-Host 'Usage: -Role worker -Token rcreg_xxx [-Name NAME] [-Labels a,b] [-Slots N]'
    Write-Host '       -Role worker -Update [-Version vX.Y.Z] [-Sha256 HEX]'
  }

  # Each role sees exactly its own flags, the same property bash gets by rotating unparsed arguments
  # to its role's own parser. One param() block for two roles would otherwise accept -Hub on a
  # Worker and silently do nothing with it.
  foreach ($nodeOnly in @('Hub', 'Source', 'Install')) {
    if ($invokedParameters -contains $nodeOnly) {
      Show-Usage
      Fail "-$nodeOnly belongs to -Role node. The Worker installer does not take it."
    }
  }

  if (-not $Update -and -not $Token) {
    Show-Usage
    Fail 'A registration token is required'
  }

  $slotsValue = 0
  if ($Slots) {
    if ($Slots -notmatch '^[0-9]+$' -or [int]$Slots -lt 1) { Fail '-Slots must be a positive integer' }
    $slotsValue = [int]$Slots
  }
  $versionArg = ''
  if ($Version) {
    $versionArg = $Version -replace '^v', ''
    if ($versionArg -notmatch '^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)*$') {
      Fail '-Version must be a release version such as v1.2.3'
    }
  }
  if ($Sha256 -and $Sha256 -notmatch '^[0-9a-f]{64}$') {
    Fail '-Sha256 must be a 64-character lowercase hex digest'
  }

  # PROCESSOR_ARCHITEW6432 is what a 32-bit PowerShell on a 64-bit host reports the real machine as;
  # without it a WOW64 shell would call an x64 Server "x86" and be refused.
  $processorArch = $env:PROCESSOR_ARCHITECTURE
  if ($env:PROCESSOR_ARCHITEW6432) { $processorArch = $env:PROCESSOR_ARCHITEW6432 }
  if ($processorArch -ne 'AMD64') {
    Fail "This installer onboards x64 Windows Workers only; this host reports $processorArch. The Hyper-V provisioner and every Windows parent image in the catalog are x64."
  }
  $machineOs = 'win'
  $machineArch = 'x86_64'

  # The release archive is a .tar.gz, which Expand-Archive cannot read. bsdtar has shipped in
  # Windows since Server 2019 / Windows 10 1803. Refuse rather than reach for an unverified
  # alternative: there is no second way to unpack the pinned bytes that is also the pinned bytes.
  if (-not (Get-Command 'tar.exe' -ErrorAction SilentlyContinue)) {
    Fail 'tar.exe is required to unpack the pinned agent archive and is not on PATH. It ships with Windows Server 2019 and Windows 10 1803 and later.'
  }

  function Get-MetaField($key) {
    if (-not (Test-Path -LiteralPath $metaFile)) { return '' }
    $line = Get-Content -LiteralPath $metaFile | Where-Object { $_.StartsWith("$key=") } | Select-Object -Last 1
    if (-not $line) { return '' }
    return $line.Substring($key.Length + 1)
  }

  # install-meta is KEY=value, one per line, byte-for-byte the shape the POSIX installer writes and
  # in the same key order. start-agent.ps1 and rc.ps1 both read it with a prefix match; JSON would
  # put a parser in each of them for no gain, and the two platforms would drift.
  function Write-Meta($nodeBin, $serviceKind, $agentVersion) {
    $lines = @(
      "SITE_URL=$siteUrl",
      "NODE_BIN=$nodeBin",
      "MACHINE_NAME=$machineName",
      "SERVICE_KIND=$serviceKind",
      "AGENT_VERSION=$agentVersion"
    )
    Set-Content -LiteralPath $metaFile -Value $lines -Encoding ASCII
    Protect-Path $metaFile
  }

  function Get-ServiceKind { return (Get-MetaField 'SERVICE_KIND') }

  function Stop-Agent {
    if ((Get-ServiceKind) -eq 'schtask') {
      Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    }
  }

  function Start-Agent($kind) {
    if ($kind -ne 'schtask') {
      Fail 'EraInfra service metadata is missing. Re-run the install command from the dashboard.'
    }
    # Stop first, then start: "already running" is the dangerous success here, because the process
    # that is already running is executing the bytes this install just replaced.
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null
    Start-ScheduledTask -TaskName $taskName
  }

  # Never delete the working agent before its replacement is staged and verified: every failure path
  # above the swap leaves agent\ untouched, and this puts it back if the swap or the first connection
  # attempt goes wrong.
  function Restore-Previous {
    if (-not (Test-Path -LiteralPath $previousDir)) { return $false }
    Remove-Item -LiteralPath $agentDir -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $previousDir -Destination $agentDir -Force
    return $true
  }

  $computerSystem = Get-CimInstance -ClassName Win32_ComputerSystem
  $cpus = [int]$computerSystem.NumberOfLogicalProcessors
  $memoryMiB = [int][math]::Floor([double]$computerSystem.TotalPhysicalMemory / 1MB)
  $machineName = $Name
  if (-not $machineName) { $machineName = $env:COMPUTERNAME }
  $previousVersion = Get-MetaField 'AGENT_VERSION'

  New-Item -ItemType Directory -Force -Path $rcHome, $binDir | Out-Null
  # No trap-on-EXIT equivalent runs reliably across every way this script can end, so an
  # interrupted install leaves its staging directory behind. Sweep them rather than accumulate.
  Get-ChildItem -LiteralPath $rcHome -Directory -Filter 'install.*' -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  $tmpDir = Join-Path $rcHome ("install." + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

  Say "Detected $machineOs $machineArch with $cpus CPUs and $memoryMiB MiB memory ($machineName)."

  # --- the runtime -----------------------------------------------------------------------------
  # The archive is prebuilt and toolchain-independent, but it is JavaScript: it needs a Node runtime
  # to execute, and a fresh Windows Server has none - measured, not assumed, on a real Server 2022
  # box. So this installs one, from nodejs.org, verified against the SHASUMS256.txt nodejs.org
  # publishes beside the build. That is the same source and the same trust model the POSIX installer
  # already uses for exactly this case; Windows differs only in that the published artifact is a
  # .zip rather than a .tar.gz. Nothing is compiled here and no toolchain is installed.
  $nodeExe = ''
  $onPath = Get-Command 'node.exe' -ErrorAction SilentlyContinue
  if (-not $onPath) { $onPath = Get-Command 'node' -ErrorAction SilentlyContinue }
  if ($onPath) {
    $candidate = $onPath.Source
    $major = 0
    try { $major = [int](& $candidate -p 'Number(process.versions.node.split(".")[0])') } catch { $major = 0 }
    if ($major -ge 20) { $nodeExe = $candidate }
  }
  $bundledNode = Join-Path (Join-Path $rcHome 'node') 'node.exe'
  if (-not $nodeExe -and (Test-Path -LiteralPath $bundledNode)) {
    $major = 0
    try { $major = [int](& $bundledNode -p 'Number(process.versions.node.split(".")[0])') } catch { $major = 0 }
    if ($major -ge 20) { $nodeExe = $bundledNode }
  }

  if (-not $nodeExe) {
    Say 'Installing the latest official Node.js 22 release.'
    $shasumsUri = 'https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt'
    $shasums = ''
    try {
      $shasums = (Invoke-WebRequest -Uri $shasumsUri -UseBasicParsing).Content
    } catch {
      Fail "Could not download the Node.js checksum list from $shasumsUri"
    }
    $nodeArchive = ''
    $nodeExpected = ''
    foreach ($line in ($shasums -split '\r?\n')) {
      $fields = $line.Trim() -split '\s+'
      if ($fields.Count -ge 2 -and $fields[1] -match '^node-v22\.[0-9.]+-win-x64\.zip$') {
        $nodeExpected = $fields[0]
        $nodeArchive = $fields[1]
        break
      }
    }
    if (-not $nodeArchive) { Fail 'Could not find a Node.js 22 build for win-x64' }
    $nodeZip = Join-Path $tmpDir $nodeArchive
    Get-VerifiedDownload -Uri "https://nodejs.org/dist/latest-v22.x/$nodeArchive" -Destination $nodeZip -Expected $nodeExpected -What 'The Node.js archive' | Out-Null
    $nodeExtract = Join-Path $tmpDir 'node-extract'
    New-Item -ItemType Directory -Force -Path $nodeExtract | Out-Null
    # Expand-Archive is a cmdlet, so -ErrorAction Stop does cover it; the post-condition below is
    # what covers an archive that expands to a shape this script did not expect.
    Expand-Archive -LiteralPath $nodeZip -DestinationPath $nodeExtract -Force
    $extracted = Get-ChildItem -LiteralPath $nodeExtract -Directory | Where-Object { $_.Name -like 'node-v22*' } | Select-Object -First 1
    if (-not $extracted) { Fail 'Could not extract Node.js' }
    $nodeRoot = Join-Path $rcHome 'node'
    Remove-Item -LiteralPath $nodeRoot -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $extracted.FullName -Destination $nodeRoot -Force
    $nodeExe = Join-Path $nodeRoot 'node.exe'
    if (-not (Test-Path -LiteralPath $nodeExe)) { Fail 'The extracted Node.js has no node.exe' }
  } else {
    Say "Using Node.js $(& $nodeExe --version) at $nodeExe."
  }

  # The Windows distribution puts node.exe, npm and npm.cmd side by side at the root of the archive,
  # where the POSIX one has a bin/ directory.
  $nodeBinDir = Split-Path -Parent $nodeExe
  $npmCmd = Join-Path $nodeBinDir 'npm.cmd'
  if (-not (Test-Path -LiteralPath $npmCmd)) { Fail "npm.cmd was not found next to $nodeExe" }

  # --- the archive -----------------------------------------------------------------------------
  if ($Update -and -not (Test-Path -LiteralPath $envFile)) {
    Fail 'No existing EraInfra registration was found; use a dashboard install command first'
  }
  $envBackup = Join-Path $tmpDir 'agent.env'
  if (Test-Path -LiteralPath $envFile) { Copy-Item -LiteralPath $envFile -Destination $envBackup -Force }

  $installVersion = $pinnedVersion
  if ($versionArg) { $installVersion = $versionArg }
  if (-not $installVersion) { Fail 'This EraInfra deployment pins no agent version; redeploy the backend' }
  if ($versionArg -and $installVersion -ne $pinnedVersion -and -not $Sha256) {
    Fail 'Updating to a release other than the deployment pin requires -Sha256 with an independently verified digest'
  }

  $asset = "erainfra-agent-$installVersion.tar.gz"
  $releaseUrl = "https://github.com/$agentRepo/releases/download/v$installVersion"
  $archive = Join-Path $tmpDir $asset

  Say "Downloading the EraInfra agent $installVersion release."
  $downloaded = $false
  try {
    Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $archive -UseBasicParsing
    $downloaded = $true
  } catch {
    $downloaded = $false
  }
  if (-not $downloaded) {
    # Pre-rename releases keep their published asset names forever (CONTEXT.md rule 4).
    $asset = "runner-center-agent-$installVersion.tar.gz"
    $archive = Join-Path $tmpDir $asset
    try {
      Invoke-WebRequest -Uri "$releaseUrl/$asset" -OutFile $archive -UseBasicParsing
    } catch {
      Fail "Could not download $asset from release v$installVersion of $agentRepo"
    }
  }

  $expectedSha = $Sha256
  $checksumSource = 'the checksum passed on the command line'
  if (-not $expectedSha) {
    $sidecar = "$archive.sha256"
    try {
      Invoke-WebRequest -Uri "$releaseUrl/$asset.sha256" -OutFile $sidecar -UseBasicParsing
    } catch {
      Fail "Could not download the checksum published with release v$installVersion"
    }
    $firstLine = (Get-Content -LiteralPath $sidecar -TotalCount 1)
    if ($firstLine) { $expectedSha = ($firstLine.Trim() -split '\s+')[0] }
    $checksumSource = 'the checksum published with the release'
  }
  # An unreadable or missing sidecar leaves this empty, and an empty expectation must never read as
  # a satisfied one. Refuse before anything is compared.
  if (-not $expectedSha) { Fail 'The expected agent checksum is empty' }

  $actualSha = Get-Sha256 $archive
  if ($actualSha -ne $expectedSha) {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Fail "Agent archive checksum verification failed: expected $expectedSha but got $actualSha. Nothing was installed."
  }
  # The release vouching for an archive is not enough. This deployment's own pin arrived with this
  # script over TLS from an origin outside the release, and it is the trust root: an archive that
  # matches the release but not the pin is refused.
  if ($pinnedSha256 -and $installVersion -eq $pinnedVersion) {
    if ($actualSha -ne $pinnedSha256) {
      Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
      Fail "Agent archive does not match the checksum pinned by this EraInfra deployment: expected $pinnedSha256 but got $actualSha. Nothing was installed."
    }
    $checksumSource = 'the checksum pinned by this EraInfra deployment'
  }
  Say "Verified the agent archive against $checksumSource."

  # --- staging ---------------------------------------------------------------------------------
  $stageDir = Join-Path $tmpDir 'staged-agent'
  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
  # ARCHIVE_ROOT is "agent" and is frozen; --strip-components=1 is what turns it into $stageDir.
  Invoke-Native -Exe 'tar.exe' -CommandArgs @('-xzf', $archive, '-C', $stageDir, '--strip-components=1') -What 'Unpacking the agent archive'
  if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $stageDir 'dist') 'index.js'))) { Fail 'The agent archive is missing dist/index.js' }
  if (-not (Test-Path -LiteralPath (Join-Path $stageDir 'package-lock.json'))) { Fail 'The agent archive is missing package-lock.json' }
  if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $stageDir 'provisioners') 'provision-win.ps1'))) {
    Fail 'The agent archive is missing provisioners/provision-win.ps1, so this Worker could not run a job'
  }
  if (Test-Path -LiteralPath $envBackup) { Copy-Item -LiteralPath $envBackup -Destination (Join-Path $stageDir '.env') -Force }

  # npm ci against the lockfile the release shipped: ci resolves no version range, it lays down
  # exactly the tree package-lock.json names. Nothing is compiled here, and no toolchain is needed.
  Say 'Installing agent dependencies from the release lockfile.'
  Push-Location $stageDir
  try {
    Invoke-Native -Exe $npmCmd -CommandArgs @('ci', '--omit=dev', '--no-audit', '--no-fund') -What 'Installing agent dependencies'
  } finally {
    Pop-Location
  }

  # --- the swap --------------------------------------------------------------------------------
  Say 'Replacing the installed agent.'
  Stop-Agent
  Remove-Item -LiteralPath $previousDir -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $agentDir) { Move-Item -LiteralPath $agentDir -Destination $previousDir -Force }
  try {
    Move-Item -LiteralPath $stageDir -Destination $agentDir -Force
  } catch {
    if (Restore-Previous) { Fail 'Could not install the new agent; the previous installation was restored' }
    Fail 'Could not install the new agent, and no previous installation was available'
  }

  # --- registration ----------------------------------------------------------------------------
  if (-not $Update) {
    Say 'Registering this machine.'
    $payload = @{
      registrationToken = $Token
      name = $machineName
      os = $machineOs
      arch = $machineArch
      cpus = $cpus
      memoryMiB = $memoryMiB
    }
    if ($Labels) {
      $labelList = @($Labels -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
      if ($labelList.Count -gt 0) { $payload['labels'] = $labelList }
    }
    if ($slotsValue -gt 0) { $payload['maxSlots'] = $slotsValue }

    $registration = $null
    try {
      $response = Invoke-WebRequest -Uri "$siteUrl/agents/register" -Method Post -ContentType 'application/json' -Body ($payload | ConvertTo-Json -Compress) -UseBasicParsing
      $registration = $response.Content | ConvertFrom-Json
    } catch {
      # PowerShell 7 puts the response body in ErrorDetails; 5.1 leaves it on the WebException's
      # response stream. Read whichever is there, so the operator sees the server's own refusal
      # rather than "the remote server returned an error".
      $serverMessage = ''
      $status = ''
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $serverMessage = $_.ErrorDetails.Message }
      $webResponse = $null
      try { $webResponse = $_.Exception.Response } catch { $webResponse = $null }
      if ($webResponse) {
        try { $status = [int]$webResponse.StatusCode } catch { $status = '' }
        if (-not $serverMessage) {
          try {
            $reader = New-Object IO.StreamReader($webResponse.GetResponseStream())
            $serverMessage = $reader.ReadToEnd()
            $reader.Close()
          } catch {
            $serverMessage = ''
          }
        }
      }
      try {
        $parsed = $serverMessage | ConvertFrom-Json
        if ($parsed.error) { $serverMessage = $parsed.error }
      } catch {
        $parsed = $null   # a non-JSON body is reported exactly as the server sent it
      }
      if (-not $serverMessage) { $serverMessage = 'Could not reach the EraInfra registration endpoint' }
      if ($status) { Fail "$serverMessage (HTTP $status)" }
      Fail $serverMessage
    }
    if (-not $registration.machineToken -or -not $registration.convexUrl) {
      Fail 'The registration response carried no machine token'
    }
    Set-Content -LiteralPath $envFile -Encoding ASCII -Value @(
      "CONVEX_URL=$($registration.convexUrl)",
      "MACHINE_TOKEN=$($registration.machineToken)"
    )
    Protect-Path $envFile
  } else {
    $oldName = Get-MetaField 'MACHINE_NAME'
    if ($oldName) { $machineName = $oldName }
  }

  # --- the launcher ----------------------------------------------------------------------------
  # The scheduled task holds no credential. It runs this, and this reads .env and install-meta -
  # exactly what start-agent.sh does on POSIX, and the reason the task definition is world-readable.
  #
  # It also owns the log. On POSIX the service manager redirects (launchd StandardOutPath, systemd
  # StandardOutput=append:); a Scheduled Task cannot redirect at all, so doing it here is the only
  # way agent.log exists - and agent.log is the file rc.ps1 and the connection wait both read.
  Set-Content -LiteralPath $startScript -Encoding ASCII -Value @(
    '#Requires -Version 5.1',
    '$ErrorActionPreference = "Stop"',
    ('$rcHome = ' + "'$rcHome'"),
    '$agentDir = Join-Path $rcHome "agent"',
    '$metaFile = Join-Path $rcHome "install-meta"',
    '$readyFile = Join-Path $rcHome "agent.ready"',
    '$logFile = Join-Path $rcHome "agent.log"',
    'function Field($key) {',
    '  $line = Get-Content -LiteralPath $metaFile | Where-Object { $_.StartsWith("$key=") } | Select-Object -Last 1',
    '  if (-not $line) { return "" }',
    '  return $line.Substring($key.Length + 1)',
    '}',
    'foreach ($line in (Get-Content -LiteralPath (Join-Path $agentDir ".env"))) {',
    '  if ($line -match "^([A-Za-z_][A-Za-z0-9_]*)=(.*)$") {',
    '    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2])',
    '  }',
    '}',
    '$env:RC_HOME = $rcHome',
    '$env:RC_AGENT_VERSION = Field "AGENT_VERSION"',
    '$env:RC_READY_FILE = $readyFile',
    '$env:RC_BENCHMARK_DIR = Join-Path $rcHome "benchmarks"',
    'Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue',
    '$nodeBin = Field "NODE_BIN"',
    'Set-Location -LiteralPath $agentDir',
    '# Continue, not Stop, for this one call: redirecting a native program under -ErrorAction Stop',
    '# turns every line it writes to stderr into a terminating NativeCommandError, so a single',
    '# warning from the agent would look like a crash and the service would restart in a loop.',
    '$ErrorActionPreference = "Continue"',
    '& $nodeBin (Join-Path $agentDir "dist\index.js") *>> $logFile',
    'exit $LASTEXITCODE'
  )

  # --- the CLI ---------------------------------------------------------------------------------
  # Built beside and renamed rather than truncated in place. PowerShell parses a script whole before
  # it runs, so it does not corrupt its own running shell the way bash does - but a half-written
  # rc.ps1 left by an interrupted install is a broken CLI either way.
  $rcCliTmp = "$rcCli.new"
  Set-Content -LiteralPath $rcCliTmp -Encoding ASCII -Value @(
    '#Requires -Version 5.1',
    '# Every flag is a declared parameter, and update forwards them with a HASHTABLE splat. Both',
    '# halves of that matter: a catch-all collects flags as an array, and splatting an array binds',
    '# positionally, so ("-Version", "v1.2.3") reaches the installer as its next two positional',
    '# arguments - the flag name lands in -Token and the install carries on. A hashtable binds by',
    '# name, which is the only form that forwards a flag as the flag it is.',
    'param(',
    '  [Parameter(Position = 0)][string]$Command = "status",',
    '  [string]$Version = "",',
    '  [string]$Sha256 = "",',
    '  [switch]$Follow',
    ')',
    '$ErrorActionPreference = "Stop"',
    ('$rcHome = ' + "'$rcHome'"),
    ('$taskName = ' + "'$taskName'"),
    '$metaFile = Join-Path $rcHome "install-meta"',
    '$logFile = Join-Path $rcHome "agent.log"',
    'function Field($key) {',
    '  if (-not (Test-Path -LiteralPath $metaFile)) { return "" }',
    '  $line = Get-Content -LiteralPath $metaFile | Where-Object { $_.StartsWith("$key=") } | Select-Object -Last 1',
    '  if (-not $line) { return "" }',
    '  return $line.Substring($key.Length + 1)',
    '}',
    '# SERVICE_KIND is read rather than assumed even though schtask is the only value this installer',
    '# writes: install-meta is the contract with the installer, and a CLI that ignores it would keep',
    '# driving a scheduled task after a future install had moved to something else.',
    'function Kind { return (Field "SERVICE_KIND") }',
    'function Require-Kind {',
    '  if ((Kind) -ne "schtask") { Write-Error "EraInfra service metadata is missing or unrecognised."; exit 1 }',
    '}',
    'function Stop-Agent {',
    '  Require-Kind',
    '  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null',
    '}',
    'function Start-Agent {',
    '  Require-Kind',
    '  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null',
    '  Start-ScheduledTask -TaskName $taskName',
    '}',
    'function Test-Running {',
    '  if ((Kind) -ne "schtask") { return $false }',
    '  return ((Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue).State -eq "Running")',
    '}',
    'switch ($Command) {',
    '  "status" {',
    '    $state = "stopped"',
    '    if (Test-Running) { $state = "running" }',
    '    Write-Host ("Machine: " + (Field "MACHINE_NAME"))',
    '    Write-Host ("Agent: " + (Field "AGENT_VERSION"))',
    '    Write-Host ("Status: " + $state)',
    '    $last = Get-Content -LiteralPath $logFile -Tail 1 -ErrorAction SilentlyContinue',
    '    if ($last) { Write-Host ("Last log: " + $last) }',
    '  }',
    '  "doctor" {',
    '    Write-Host ("Host: Windows " + $env:PROCESSOR_ARCHITECTURE)',
    '    Write-Host ("Agent: " + (Field "AGENT_VERSION"))',
    '    Write-Host ("Service: " + (Kind))',
    '    $hypervisor = (Get-CimInstance -ClassName Win32_ComputerSystem).HypervisorPresent',
    '    if ($hypervisor -and (Get-Command Get-VM -ErrorAction SilentlyContinue)) {',
    '      Write-Host "OK Hyper-V is present and the Hyper-V PowerShell module is available."',
    '    } else {',
    '      Write-Warning "Hyper-V or its PowerShell module is unavailable; no Windows job can be provisioned."',
    '    }',
    '    $images = Join-Path $rcHome "images"',
    '    if (Test-Path -LiteralPath $images) {',
    '      Write-Host ("Parent images: " + @(Get-ChildItem -LiteralPath $images -Filter "*.vhdx" -ErrorAction SilentlyContinue).Count)',
    '    } else {',
    '      Write-Warning "No parent images at $images; build one with provisioners/build-image.ps1."',
    '    }',
    '    Write-Warning "Windows Profiles stay preview-gated: the control plane does not advertise a Hyper-V Worker as ready until Hyper-V passes live validation."',
    '  }',
    '  "logs" {',
    '    if ($Follow) {',
    '      Get-Content -LiteralPath $logFile -Tail 100 -Wait',
    '    } else {',
    '      Get-Content -LiteralPath $logFile -Tail 100 -ErrorAction SilentlyContinue',
    '    }',
    '  }',
    '  "restart" { Start-Agent; Write-Host "EraInfra agent restarted." }',
    '  "stop" { Stop-Agent; Write-Host "EraInfra agent stopped." }',
    '  "update" {',
    '    $site = Field "SITE_URL"',
    '    if (-not $site) { Write-Error "EraInfra site URL is missing."; exit 1 }',
    '    $installer = [scriptblock]::Create((Invoke-RestMethod -Uri ($site + "/install.ps1")))',
    '    $forward = @{ Role = "worker"; Update = $true }',
    '    if ($Version) { $forward["Version"] = $Version }',
    '    if ($Sha256) { $forward["Sha256"] = $Sha256 }',
    '    & $installer @forward',
    '  }',
    '  "uninstall" {',
    '    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue | Out-Null',
    '    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue',
    '    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")',
    '    $binDir = Join-Path $rcHome "bin"',
    '    if ($userPath) {',
    '      $kept = @($userPath -split ";" | Where-Object { $_ -and $_ -ne $binDir })',
    '      [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")',
    '    }',
    '    Set-Location -LiteralPath $env:USERPROFILE',
    '    Remove-Item -LiteralPath $rcHome -Recurse -Force -ErrorAction SilentlyContinue',
    '    Write-Host "EraInfra was removed. Delete the machine from the dashboard to remove its registration."',
    '  }',
    '  default {',
    '    Write-Host "Usage: rc.ps1 status | doctor | logs [-Follow] | restart | stop | update [-Version vX.Y.Z] [-Sha256 HEX] | uninstall"',
    '  }',
    '}'
  )
  Move-Item -LiteralPath $rcCliTmp -Destination $rcCli -Force

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $userPath) { $userPath = '' }
  if (($userPath -split ';') -notcontains $binDir) {
    $joined = $binDir
    if ($userPath) { $joined = "$binDir;$userPath" }
    [Environment]::SetEnvironmentVariable('Path', $joined, 'User')
    Say "Added $binDir to your user PATH; open a new shell to pick up 'rc.ps1'."
  } else {
    Say "The EraInfra CLI is already on your user PATH."
  }

  # --- persistence -----------------------------------------------------------------------------
  # A Scheduled Task registered for the CURRENT USER, at logon. Not a Windows service, and this is
  # the constraint that decides it rather than a preference:
  #
  #   provisioners/build-image.ps1 stores the guest credential with Export-Clixml, which is
  #   USER-SCOPE DPAPI, and provisioners/provision-win.ps1 reads it back with Import-Clixml. DPAPI
  #   material written by one account cannot be decrypted by another. So the account that runs this
  #   agent MUST be the account that ran build-image.ps1, or every Hyper-V provision fails at
  #   credential decryption with an error that reads like a corrupt file.
  #
  # That rules out LocalSystem, which is what a service wrapper would have run as, and it rules out
  # a task registered with the S4U logon type: an S4U token carries no credentials, so it cannot
  # unlock the user's DPAPI master key either. An interactive logon token can, which leaves exactly
  # this. It is also what the Node role's own scheduled task already does.
  #
  # The cost is stated rather than hidden: this starts at LOGON, so an unattended reboot leaves the
  # Worker down until someone signs in. On a dedicated Worker box, enable automatic logon. Changing
  # this to a boot-time service means first moving the guest credential to machine-scope DPAPI in
  # both provisioner scripts, which is its own change and needs a real Windows host to verify.
  $serviceKind = 'schtask'
  # The principal is named from the same environment that decided where RC_HOME lives. That is the
  # point rather than a shortcut: %USERPROFILE% belongs to one account, the DPAPI credential is
  # readable by one account, and this makes them provably the same one. Refuse rather than guess.
  if (-not $env:USERNAME) {
    Fail 'USERNAME is not set, so this installer cannot name the account the agent has to run as.'
  }
  $taskUser = $env:USERNAME
  if ($env:USERDOMAIN) { $taskUser = $env:USERDOMAIN + '' + $env:USERNAME }
  # Highest, because the Hyper-V provisioner needs elevation to create and destroy a VM. On an
  # account that is not a local administrator the task registers and then cannot provision, which
  # rc.ps1 doctor reports.
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $startScript + '"')
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

  # start-agent.ps1 reads NODE_BIN and AGENT_VERSION out of the metadata file, so it has to exist
  # before anything starts the service.
  Write-Meta $nodeExe $serviceKind $installVersion

  Set-Content -LiteralPath $logFile -Value '' -Encoding ASCII
  Remove-Item -LiteralPath $readyFile -Force -ErrorAction SilentlyContinue
  Start-Agent $serviceKind
  Say "Started the EraInfra agent with $serviceKind."

  $connected = $false
  foreach ($second in 1..20) {
    $signal = ''
    if (Test-Path -LiteralPath $readyFile) {
      # A file that exists but is empty makes Get-Content return nothing, and .Trim() on nothing is
      # a terminating error under -ErrorAction Stop. An empty signal is "not connected yet".
      $firstReadyLine = Get-Content -LiteralPath $readyFile -TotalCount 1 -ErrorAction SilentlyContinue
      if ($firstReadyLine) { $signal = $firstReadyLine.Trim() }
    }
    if ($signal -eq $installVersion) {
      $connected = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $connected) {
    $lastLog = Get-Content -LiteralPath $logFile -Tail 1 -ErrorAction SilentlyContinue
    # Only an update can roll back: a fresh install has just registered a new machine, and the
    # preserved directory holds the previous machine's identity.
    if ($Update -and (Restore-Previous)) {
      Write-Meta $nodeExe $serviceKind $previousVersion
      try { Start-Agent $serviceKind } catch { Warn 'The restored agent did not start either.' }
      Fail "Agent $installVersion did not connect within 20 seconds; rolled back to the previous installation. Last log: $lastLog"
    }
    if ($lastLog) { Fail "Agent did not connect within 20 seconds. Last log: $lastLog" }
    Fail "Agent did not connect within 20 seconds; check $logFile"
  }

  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  Say "EraInfra $installVersion is connected. Dashboard: $siteUrl"
  Warn 'Windows Profiles are preview-gated: the control plane does not advertise a Hyper-V Worker as ready until Hyper-V passes live validation, so this machine will not be scheduled onto yet.'
  exit 0
}

# The dispatch, and the only place either role is chosen. It reads nothing from the environment and
# nothing from a URL: one body, rendered from this deployment's own configuration.
if ($Role -eq "worker") {
  Install-Worker
  exit 0
}
if ($Role -ne "node") {
  Fail "Unknown -Role: $Role (expected worker or node)"
}
foreach ($workerOnly in @('Labels', 'Slots', 'Update', 'Version', 'Sha256')) {
  if ($invokedParameters -contains $workerOnly) {
    Fail "-$workerOnly belongs to -Role worker. The Node installer does not take it."
  }
}
if (-not $Token) { $Token = Get-RenamedEnv "ERAINFRA_TOKEN" "PORTLESS_TOKEN" }
if (-not $Hub) { $Hub = Get-RenamedEnv "ERAINFRA_HUB" "PORTLESS_HUB" }

__NODE_BODY__
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

/** The Node body with this deployment's Infra Agent pin substituted in. */
function renderNodeInstallBody(release: AgentRelease) {
  return POWERSHELL_NODE_BODY.replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__INFRA_AGENT_DIGESTS__", renderPinnedDigests(release.infraAgent));
}

/**
 * The one body `/install.ps1` serves: shared preamble, Worker, dispatch, Node.
 *
 * `siteUrl` is interpolated into a single-quoted PowerShell string in a script an operator runs, so
 * it is checked the same way `installScript.ts` checks it — the route only ever hands this a
 * `resolveSiteUrl` origin, which URL parsing confines to scheme, host and port, but a renderer that
 * trusts its caller is one refactor away from being wrong.
 */
export function renderWindowsInstallScript(siteUrl: string, release: AgentRelease) {
  const origin = siteUrl.replace(/\/+$/, "");
  if (origin.includes("'") || /[\r\n]/.test(origin)) {
    throw new Error("The site URL cannot be rendered into the Windows installer safely");
  }
  return WINDOWS_INSTALL_SCRIPT.replaceAll("__NODE_PARAMS__", POWERSHELL_NODE_PARAMS.join("\n"))
    .replaceAll("__NODE_BODY__", renderNodeInstallBody(release))
    .replaceAll("__ERAINFRA_SITE_URL__", origin)
    .replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__AGENT_SHA256__", release.sha256);
}
