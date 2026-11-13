import type { AgentRelease } from "./agentRelease";
import { WINDOWS_UPDATE_HEALTH_CHECK } from "./installScriptPowerShellUpdate.ts";
import { UPDATE_READY_TIMEOUT_SECONDS } from "./updateHealthCheck.ts";

/**
 * `/install.ps1`: the Windows installer. It installs the Worker role only.
 *
 * It served the Node role first, and a Worker role joined it in #49. The Windows Node role ran the
 * Infra Agent in Hub mode only (`connect --hub --token`), and Hub mode retired on 2026-11-08. A Node
 * now runs connect-convex beside the erainfra-mesh systemd unit, so the Node role needs Linux with
 * systemd and the bash installer (`/install --role node`). `-Role node` here fails and says so. The
 * installer of release v0.2.0-rc.19 still has the Windows Node role.
 *
 * This is the PowerShell counterpart of `installScript.ts`, and it mirrors that file's supply chain
 * rather than inventing a second one: the archive named by this deployment's `AGENT_RELEASE`, the
 * digest published beside it, and the digest this deployment pins, which is a trust root outside
 * the release. An archive the release vouches for but the pin does not is refused. `#49`'s design
 * reference reached GitHub over an unpinned branch tarball and then ran `npm install && npm run
 * build` on the customer's machine; none of that is here.
 *
 * The rendered script must stay pure ASCII: Windows PowerShell 5.1 reads a BOM-less file as ANSI,
 * and this one is fetched over HTTP and built with `[scriptblock]::Create`, so there is no BOM to
 * read.
 *
 * Nothing in the Worker body has been executed on Windows. See `installScriptPowerShell.test.ts`
 * for what the suite does and does not prove.
 */
const WINDOWS_INSTALL_SCRIPT = String.raw`#Requires -Version 5.1
# The EraInfra installer for Windows. It installs a Worker, which executes CI jobs and runs the
# Action Runner Agent:
#
#     & ([scriptblock]::Create((irm <site>/install.ps1))) -Role worker -Token rcreg_xxx
#
# -Role still defaults to "node", the Windows Node role this URL served first. That role ran only in
# Hub mode, which retired on 2026-11-08, so -Role node now fails with that reason. Node install
# commands already in operators' hands omit -Role, and with this default they fail the same way
# instead of running the Worker installer.
#
# Install-Worker reads these parameters through PowerShell's dynamic scoping, which
# PSReviewUnusedParameter does not follow into a nested function. The attribute is not
# [CmdletBinding()], so the script stays a simple one that leaves unbound arguments in $args.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSReviewUnusedParameter', '', Justification = 'Install-Worker reads them through dynamic scoping')]
param(
  [string]$Role = "node",
  [string]$Token = "",
  [string]$Name = "",
  [string]$Labels = "",
  [string]$Slots = "",
  [switch]$Update,
  [string]$Version = "",
  [string]$Sha256 = "",
  [string]$ReadyTimeout = ""
)
$ErrorActionPreference = "Stop"
# param() has no [CmdletBinding()], so PowerShell puts an argument it cannot bind into $args instead
# of refusing it. $args is per-scope: inside a function it holds that function's own arguments, not
# the script's. The Worker checks what the OPERATOR passed, so the script's own set is captured
# here, once, where it is still in scope.
$unboundArguments = @($args)
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
# comparison could be written wrongly, and it is the same one for the Worker archive, the Node.js
# runtime and the service wrapper.
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
  # is the Action Runner Agent's task, and a box that was once a Windows Node still has a task
  # named PortlessAgent.
  $taskName = 'erainfra-action-runner-agent'

  function Show-Usage {
    Write-Host 'Usage: -Role worker -Token rcreg_xxx [-Name NAME] [-Labels a,b] [-Slots N]'
    Write-Host '       -Role worker -Update [-Version vX.Y.Z] [-Sha256 HEX] [-ReadyTimeout SECONDS]'
  }

  # -Hub, -Source and -Install belonged to the retired Windows Node role. They are no longer in
  # param(), so they arrive unbound; refuse them rather than accept them and do nothing.
  foreach ($nodeOnly in @('-Hub', '-Source', '-Install')) {
    if ($unboundArguments -contains $nodeOnly) {
      Show-Usage
      Fail "$nodeOnly belonged to the retired Windows Node role. The Worker installer does not take it."
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
  # How long an update waits for each Profile that was ready before it to report ready again
  # (UPDATE_READY_TIMEOUT_SECONDS in updateHealthCheck.ts, which says why). Nine digits at most, so
  # [int] cannot overflow on a typo.
  $readyTimeoutSeconds = __UPDATE_READY_TIMEOUT__
  if ($ReadyTimeout) {
    if ($ReadyTimeout -notmatch '^[0-9]{1,9}$' -or [int]$ReadyTimeout -lt 1) {
      Fail '-ReadyTimeout must be a positive number of seconds'
    }
    $readyTimeoutSeconds = [int]$ReadyTimeout
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

  # Wait up to 20 seconds for the agent of version $version to publish that it reached the control
  # plane.
  function Wait-ForConnection($version) {
    foreach ($second in 1..20) {
      $signal = ''
      if (Test-Path -LiteralPath $readyFile) {
        # A file that exists but is empty makes Get-Content return nothing, and .Trim() on nothing
        # is a terminating error under -ErrorAction Stop. An empty signal is "not connected yet".
        $firstReadyLine = Get-Content -LiteralPath $readyFile -TotalCount 1 -ErrorAction SilentlyContinue
        if ($firstReadyLine) { $signal = $firstReadyLine.Trim() }
      }
      if ($signal -eq $version) { return $true }
      Start-Sleep -Seconds 1
    }
    return $false
  }

__WINDOWS_UPDATE_HEALTH_CHECK__

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

  # An update is health-checked: the Profiles the control plane sees ready now must report ready
  # again from the new agent, or the update rolls back.
  if ($Update) {
    $tokenLine = Get-Content -LiteralPath $envFile | Where-Object { $_.StartsWith('MACHINE_TOKEN=') } | Select-Object -Last 1
    if ($tokenLine) { $readinessHeaders['Authorization'] = 'Bearer ' + $tokenLine.Substring('MACHINE_TOKEN='.Length) }
    $readinessFile = Join-Path $tmpDir 'readiness.json'
    $readinessBeforeFile = Join-Path $tmpDir 'readiness-before.json'
    if (-not (Read-Readiness $readinessBeforeFile)) {
      Fail "Could not read this Worker's Profile readiness from $siteUrl/agents/readiness; the running agent was left in place"
    }
    $readyBefore = Invoke-ReadinessReader @('ready', $readinessBeforeFile)
    if ($null -eq $readyBefore) {
      Fail "Could not read this Worker's Profile readiness from $siteUrl/agents/readiness; the running agent was left in place"
    }
    if ($readyBefore.Count -gt 0) {
      Say "Ready before the update: $($readyBefore -join ', ')."
    }
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
    '  [string]$ReadyTimeout = "",',
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
    '    Write-Host "A Hyper-V Profile is advertised ready once readiness proves the Hyper-V module, the VM switch, the parent VHDX and its credential file on this Worker."',
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
    '    if ($ReadyTimeout) { $forward["ReadyTimeout"] = $ReadyTimeout }',
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
    '    Write-Host "Usage: rc.ps1 status | doctor | logs [-Follow] | restart | stop | update [-Version vX.Y.Z] [-Sha256 HEX] [-ReadyTimeout SECONDS] | uninstall"',
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
  # A Scheduled Task registered for the CURRENT USER, at logon. Not a Windows service.
  #
  # This was decided when provisioners/build-image.ps1 stored the guest credential with
  # Export-Clixml, USER-SCOPE DPAPI, which only the account that ran the build can decrypt: that
  # ruled out LocalSystem and an S4U task token, and left an interactive logon token. #89 moved the
  # credential to machine-scope DPAPI (<image>.cred.json, ACLed to SYSTEM and Administrators), so
  # the account no longer has to be the one that built the image. What still ties this to the
  # installing account is RC_HOME under its %USERPROFILE%, where the images live; a boot-time
  # service is its own change and needs a real Windows host to verify.
  #
  # The cost is stated rather than hidden: this starts at LOGON, so an unattended reboot leaves the
  # Worker down until someone signs in. On a dedicated Worker box, enable automatic logon.
  $serviceKind = 'schtask'
  # The principal is named from the same environment that decided where RC_HOME lives. That is the
  # point rather than a shortcut: %USERPROFILE% belongs to one account, and this makes the task run
  # as the account whose profile holds the install. Refuse rather than guess.
  if (-not $env:USERNAME) {
    Fail 'USERNAME is not set, so this installer cannot name the account the agent has to run as.'
  }
  $taskUser = $env:USERNAME
  if ($env:USERDOMAIN) { $taskUser = $env:USERDOMAIN + '\' + $env:USERNAME }
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
  if ($readyBefore.Count -gt 0) {
    # The old agent is stopped, so any report after this moment comes from the new one.
    $readinessSince = Get-ControlPlaneNow
  }
  Start-Agent $serviceKind
  Say "Started the EraInfra agent with $serviceKind."

  if (-not (Wait-ForConnection $installVersion)) {
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

  if ($readyBefore.Count -gt 0) {
    Say "Waiting up to $readyTimeoutSeconds seconds for the $($readyBefore.Count) Profile(s) that were ready before the update to report ready again (-ReadyTimeout)."
    $healthFailure = Wait-ForReady $readinessSince $readyBefore
    if ($healthFailure) { Undo-Update $healthFailure }
    Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Say "EraInfra $installVersion is connected, and the $($readyBefore.Count) Profile(s) that were ready before the update are ready again. Dashboard: $siteUrl"
    exit 0
  }
  Remove-Item -LiteralPath $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  Say "EraInfra $installVersion is connected. Dashboard: $siteUrl"
  Say 'This Worker is scheduled onto once readiness proves the Hyper-V module, the VM switch, a parent VHDX under the images directory and its credential file. Build one with provisioners/build-image.ps1; rc.ps1 doctor shows what is missing.'
  exit 0
}

# The dispatch, and the only place the role is chosen. It reads nothing from the environment and
# nothing from a URL: one body, rendered from this deployment's own configuration.
if ($Role -eq "worker") {
  Install-Worker
  exit 0
}
if ($Role -eq "node") {
  Fail "The Windows Node role ran only in Hub mode, which retired on 2026-11-08. A Node now runs connect-convex, which needs Linux with systemd: enroll it with 'erainfra nodes enroll <name>' and install it with /install --role node. The installer of release v0.2.0-rc.19 still has the Windows Node role."
}
Fail "Unknown -Role: $Role (expected worker)"
`;

/**
 * The one body `/install.ps1` serves: shared preamble, Worker, dispatch.
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
  // A function, because a replacement string reads "$'" (in the fragment's "^[0-9]+$'") as a pattern.
  return WINDOWS_INSTALL_SCRIPT.replaceAll(
    "__WINDOWS_UPDATE_HEALTH_CHECK__",
    () => WINDOWS_UPDATE_HEALTH_CHECK,
  )
    .replaceAll("__ERAINFRA_SITE_URL__", origin)
    .replaceAll("__AGENT_REPO__", release.repo)
    .replaceAll("__AGENT_VERSION__", release.version)
    .replaceAll("__AGENT_SHA256__", release.sha256)
    .replaceAll("__UPDATE_READY_TIMEOUT__", String(UPDATE_READY_TIMEOUT_SECONDS));
}
