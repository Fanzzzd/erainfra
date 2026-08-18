/**
 * The Windows installer contract, for both roles `/install.ps1` serves.
 *
 * Two halves, and the difference between them is the honest part of this file:
 *
 * 1. Assertions on the rendered text. These always run, and they pin the properties that are
 *    statements about the script itself — the pin is the trust root, `install-meta` is KEY=value,
 *    no frozen identifier moved, no native call skips its `$LASTEXITCODE`.
 * 2. Assertions that RUN the rendered script under `pwsh`, in a sandbox whose `USERPROFILE`, `PATH`
 *    and every Windows-only cmdlet are stubs — the same shape `installScript.test.ts` uses to run
 *    the bash installer without touching the machine running the suite.
 *
 * What the second half does NOT prove: this is PowerShell 7 on the suite's own OS, not Windows
 * PowerShell 5.1 on Windows, and every Windows-only cmdlet it reaches is a stub whose ARGUMENTS are
 * asserted and whose behaviour is not. `PSUseCompatibleSyntax` and `PSUseCompatibleCommands`
 * against a 5.1 profile cover what a parse on 7 cannot. An end-to-end Windows install remains
 * unexecuted; nothing in this file should be read as claiming otherwise.
 *
 * @vitest-environment node
 */
import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { AGENT_RELEASE, type AgentRelease } from "../convex/agentRelease.ts";
import { resolveSiteUrl } from "../convex/githubAppConfig.ts";
import { renderWindowsInstallScript } from "../convex/installScriptPowerShell.ts";

const SITE_URL = "https://example.convex.site";
const TEST_REPO = "runner-center-tests/runner-center";
const MACHINE_TOKEN = "a".repeat(32);
const WINDOWS_DIGEST = "b".repeat(64);

const CURRENT: AgentRelease = {
  repo: TEST_REPO,
  version: "1.4.2",
  sha256: "",
  infraAgent: {},
};
const OLDER: AgentRelease = { ...CURRENT, version: "1.3.0" };
const WINDOWS_PINNED: AgentRelease = {
  ...CURRENT,
  infraAgent: { "windows-x86_64": WINDOWS_DIGEST, "linux-x86_64": "c".repeat(64) },
};

const sandboxes: string[] = [];
afterAll(() => {
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const PWSH = resolvePwsh();

/**
 * PowerShell is not a build dependency of this repository, so the executed half degrades to a skip
 * rather than a failure on a machine without it. CI does not get that option: `.github/workflows/
 * ci.yml` renders and parses the script in its own step, so an absent `pwsh` there is a red build
 * rather than a quietly missing check.
 */
function resolvePwsh() {
  const located = spawnSync("sh", ["-c", "command -v pwsh"], { encoding: "utf8" });
  const executable = located.status === 0 ? located.stdout.trim() : "";
  if (!executable) return undefined;
  // An absolute path, because the sandbox below replaces PATH wholesale and execvpe would then
  // look for pwsh somewhere it deliberately is not.
  const probe = spawnSync(
    executable,
    ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"],
    {
      encoding: "utf8",
    },
  );
  return probe.status === 0 ? executable : undefined;
}

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

// ---------------------------------------------------------------------------------------------
// The rendered script
// ---------------------------------------------------------------------------------------------

describe("the rendered Windows installer", () => {
  const script = renderWindowsInstallScript(SITE_URL, AGENT_RELEASE);

  it("serves both roles from one body, with one dispatch", () => {
    expect(script).toMatch(/\[string\]\$Role = "node"/);
    expect(script).toMatch(/if \(\$Role -eq "worker"\) \{\n {2}Install-Worker/);
    expect(script).toMatch(/Fail "Unknown -Role: \$Role \(expected worker or node\)"/);
  });

  // The bash installer defaults to worker. This URL cannot, because it has been serving the Node
  // installer on its own and the dashboard's Node command does not pass -Role at all.
  it("keeps the Node role as the default, so commands already in the wild still work", () => {
    const params = script.slice(
      script.indexOf("param("),
      script.indexOf(")\n$ErrorActionPreference"),
    );
    expect(params).toMatch(/\[string\]\$Role = "node"/);
    expect(script).toMatch(/Join-Path \$HOME "\.portless"/);
    expect(script).toMatch(/-TaskName "PortlessAgent"/);
  });

  it("hands each role only its own flags", () => {
    expect(script).toMatch(/foreach \(\$nodeOnly in @\('Hub', 'Source', 'Install'\)\)/);
    expect(script).toMatch(
      /foreach \(\$workerOnly in @\('Labels', 'Slots', 'Update', 'Version', 'Sha256'\)\)/,
    );
    // Captured at script scope: $PSBoundParameters inside Install-Worker describes the function's
    // own (empty) call, so reading it there would accept every foreign flag in silence.
    expect(script).toMatch(/\$invokedParameters = @\(\$PSBoundParameters\.Keys\)/);
    expect(script).not.toMatch(/Install-Worker[\s\S]*\$PSBoundParameters/);
  });

  it("carries the release this deployment pins, as the Worker's trust root", () => {
    expect(script).toMatch(new RegExp(`\\$pinnedVersion = '${AGENT_RELEASE.version}'`));
    expect(script).toMatch(new RegExp(`\\$pinnedSha256 = '${AGENT_RELEASE.sha256}'`));
    expect(script).toMatch(
      new RegExp(`\\$agentRepo = '${AGENT_RELEASE.repo.replace("/", "\\/")}'`),
    );
    expect(script).toMatch(
      /Agent archive does not match the checksum pinned by this EraInfra deployment/,
    );
    expect(script.includes("__")).toBe(false);
  });

  it("never downloads a mutable ref and never builds on the target", () => {
    expect(script).not.toMatch(/archive\/refs\/heads/);
    expect(script).toMatch(/releases\/download\/v\$installVersion/);
    // npm ci installs exactly the tree the shipped lockfile names. Nothing here resolves a version
    // range, and nothing compiles: the archive is prebuilt.
    expect(script).toMatch(/-CommandArgs @\('ci', '--omit=dev', '--no-audit', '--no-fund'\)/);
    const npmInvocations = [...script.matchAll(/\$npmCmd -CommandArgs @\(([^)]*)\)/g)].map(
      (match) => match[1],
    );
    expect(npmInvocations).toHaveLength(1);
    for (const invocation of npmInvocations) {
      expect(invocation).not.toMatch(/'install'/);
      expect(invocation).not.toMatch(/'run'/);
    }
  });

  // KEY=value, the same five keys in the same order the POSIX installer writes, because
  // start-agent.ps1 and rc.ps1 read it with a prefix match rather than a parser.
  it("writes install-meta as KEY=value, not JSON", () => {
    expect(script).toMatch(/"SITE_URL=\$siteUrl",/);
    expect(script).toMatch(/"NODE_BIN=\$nodeBin",/);
    expect(script).toMatch(/"MACHINE_NAME=\$machineName",/);
    expect(script).toMatch(/"SERVICE_KIND=\$serviceKind",/);
    expect(script).toMatch(/"AGENT_VERSION=\$agentVersion"/);
    expect(script).not.toMatch(/ConvertTo-Json[^\n]*\$metaFile/);
  });

  it("keeps every frozen identifier the release publishes", () => {
    expect(script).toMatch(/erainfra-agent-\$installVersion\.tar\.gz/);
    expect(script).toMatch(/runner-center-agent-\$installVersion\.tar\.gz/);
    expect(script).toMatch(/infra-agent-\$target\.exe/);
    expect(script).toMatch(/--strip-components=1/);
    expect(script).toMatch(/agent\.previous/);
  });

  // #48's finding, applied: $ErrorActionPreference says nothing about a native exit code, so every
  // native call has to be routed through the one helper that checks $LASTEXITCODE. This asserts
  // there is no second, unchecked way to call one.
  it("routes every native invocation through the exit-code check", () => {
    expect(script).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ Fail/);
    const workerBody = script.slice(
      script.indexOf("function Install-Worker {"),
      script.indexOf("# The dispatch, and the only place either role is chosen"),
    );
    for (const [what, call] of [
      ["unpacking the archive", /Invoke-Native -Exe 'tar\.exe'/],
      ["locking a path down", /Invoke-Native -Exe 'icacls\.exe'/],
      ["installing dependencies", /Invoke-Native -Exe \$npmCmd/],
    ] as const) {
      expect(script, what).toMatch(call);
    }

    // Every remaining `& $x` in the Worker half, each one exempt for a stated reason. A new one
    // shows up here and has to earn its place rather than slipping in unchecked.
    const bareCalls = [...new Set([...workerBody.matchAll(/& \$(\w+)/g)].map((m) => m[1]))];
    expect(bareCalls.toSorted()).toEqual([
      "bundledNode", // node -p, probing a runtime's major version: the value returned IS the check
      "candidate", //   the same probe, for a Node already on PATH
      "installer", //   rc.ps1's update: a scriptblock, not a native program
      "nodeBin", //     start-agent.ps1 launching the agent, which then exits $LASTEXITCODE itself
      "nodeExe", //     node --version, for the line reporting which runtime was found
    ]);
  });

  // Two, not one: the Worker's helper, and the Node body's own line, left exactly as it shipped.
  // Folding the Node role into the helper would be a change to a working path for no gain to it.
  it("gives the Worker one hashing helper without touching the Node body's own", () => {
    expect(script.match(/Get-FileHash/g)).toHaveLength(2);
    expect(script).toMatch(/function Get-Sha256\(\$path\) \{\n {2}return \(Get-FileHash/);
  });

  // The constraint that decides the persistence mechanism, and the one most likely to be "fixed"
  // later by someone who reads "Scheduled Task at logon" as a limitation rather than a requirement.
  // build-image.ps1 writes the guest credential with Export-Clixml (user-scope DPAPI) and
  // provision-win.ps1 reads it with Import-Clixml, so the agent has to run as the account that
  // built the image. LocalSystem cannot decrypt it, and neither can an S4U logon token.
  it("runs the agent as the account that built the image, which DPAPI requires", () => {
    expect(script).toMatch(/New-ScheduledTaskPrincipal -UserId \$taskUser -LogonType Interactive/);
    expect(script).toMatch(/if \(-not \$env:USERNAME\) \{/);
    expect(script).not.toMatch(/LogonType S4U/);
    expect(script).not.toMatch(/NT AUTHORITY/);
    // No Windows service, and therefore no third-party service wrapper in the supply chain.
    expect(script).not.toMatch(/winsw/i);
    expect(script).not.toMatch(/New-Service|sc\.exe/);
    // The reason is in the script, not only in the PR that wrote it.
    expect(script).toMatch(/Export-Clixml/);
    expect(script).toMatch(/USER-SCOPE DPAPI/);
    // And the cost is stated rather than hidden.
    expect(script).toMatch(/starts at LOGON/);
  });

  it("refuses the Node role when this deployment pins nothing for Windows", () => {
    const unpinned = renderWindowsInstallScript(SITE_URL, CURRENT);
    expect(unpinned).toMatch(/\$pinned = @\{\n+\}/);
    expect(unpinned).toMatch(/pins no Infra Agent build for \$target/);
  });

  it("carries the Windows digest and no other target's", () => {
    const pinned = renderWindowsInstallScript(SITE_URL, WINDOWS_PINNED);
    expect(pinned).toMatch(new RegExp(`"windows-x86_64" = "${WINDOWS_DIGEST}"`));
    expect(pinned).not.toMatch(/linux-x86_64/);
  });

  it("bakes in the given origin, and refuses one it could not quote safely", () => {
    const site = resolveSiteUrl("https://example.convex.site/nested/?a=1#b");
    expect(site.ok).toBe(true);
    const rendered = renderWindowsInstallScript(site.ok ? site.siteUrl : "", AGENT_RELEASE);
    expect([...rendered.matchAll(/^ {2}\$siteUrl = '([^']*)'$/gm)].map((m) => m[1])).toEqual([
      "https://example.convex.site",
    ]);
    expect(() =>
      renderWindowsInstallScript("https://evil.example/';rm -rf /;'", AGENT_RELEASE),
    ).toThrow(/cannot be rendered/);
  });

  it("says out loud that a Windows Worker is not schedulable yet", () => {
    expect(script).toMatch(/Windows Profiles are preview-gated/);
  });
});

// ---------------------------------------------------------------------------------------------
// The executed script
// ---------------------------------------------------------------------------------------------

/**
 * Every Windows-only surface the Worker path touches, replaced by something the suite can watch.
 *
 * Defined in the runner's scope rather than patched into the script: PowerShell resolves a function
 * before a cmdlet and walks the scope chain outward, so the installer runs unmodified and still
 * reaches these. `Register-ScheduledTask` and friends record their arguments so the tests can
 * assert on what the installer asked for, which is as far as an off-Windows suite can go.
 */
// No param() block: every argument lands in $args verbatim, and @args splatting is the one
// pass-through form that still binds -Role and -Token as named parameters rather than positionally.
const RUNNER = String.raw`$ErrorActionPreference = 'Stop'

function Read-Route($uri) {
  foreach ($line in (Get-Content -LiteralPath $env:RC_TEST_ROUTES)) {
    $parts = $line -split '\|'
    if ($parts[0] -eq $uri) { return $parts }
  }
  return $null
}

function Invoke-WebRequest {
  [CmdletBinding()]
  param(
    [string]$Uri,
    [string]$OutFile,
    [switch]$UseBasicParsing,
    [string]$Method,
    [string]$ContentType,
    $Body
  )
  Add-Content -LiteralPath $env:RC_TEST_REQUEST_LOG -Value $Uri
  if ($Body) { Add-Content -LiteralPath $env:RC_TEST_REQUEST_LOG -Value ('BODY ' + $Body) }
  $route = Read-Route $Uri
  if (-not $route) { throw "no route for $Uri" }
  $status = [int]$route[1]
  if ($status -ge 400) { throw "HTTP $status for $Uri" }
  if ($OutFile) {
    Copy-Item -LiteralPath $route[2] -Destination $OutFile -Force
    return
  }
  return [pscustomobject]@{ StatusCode = $status; Content = (Get-Content -Raw -LiteralPath $route[2]) }
}

function Get-CimInstance {
  [CmdletBinding()]
  param([string]$ClassName)
  return [pscustomobject]@{
    NumberOfLogicalProcessors = 8
    TotalPhysicalMemory       = [int64]17179869184
    HypervisorPresent         = $true
  }
}

function New-ScheduledTaskAction {
  [CmdletBinding()] param([string]$Execute, [string]$Argument)
  return [pscustomobject]@{ Execute = $Execute; Argument = $Argument }
}
function New-ScheduledTaskTrigger {
  [CmdletBinding()] param([switch]$AtLogOn, [switch]$AtStartup)
  return [pscustomobject]@{ AtLogOn = [bool]$AtLogOn }
}
function New-ScheduledTaskSettingsSet {
  [CmdletBinding()]
  param(
    [switch]$AllowStartIfOnBatteries,
    [switch]$DontStopIfGoingOnBatteries,
    $ExecutionTimeLimit,
    $RestartCount,
    $RestartInterval
  )
  return [pscustomobject]@{ RestartCount = $RestartCount }
}
function New-ScheduledTaskPrincipal {
  [CmdletBinding()] param([string]$UserId, [string]$LogonType, [string]$RunLevel)
  return [pscustomobject]@{ UserId = $UserId; LogonType = $LogonType }
}
function Register-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force)
  Add-Content -LiteralPath $env:RC_TEST_SERVICE_LOG -Value "register $TaskName $($Action.Argument)"
  Add-Content -LiteralPath $env:RC_TEST_SERVICE_LOG -Value "principal $($Principal.UserId) $($Principal.LogonType)"
  return [pscustomobject]@{ TaskName = $TaskName }
}
function Unregister-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName, [switch]$Confirm)
  Add-Content -LiteralPath $env:RC_TEST_SERVICE_LOG -Value "unregister $TaskName"
}
function Get-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  return [pscustomobject]@{ TaskName = $TaskName; State = 'Running' }
}
function Stop-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  Add-Content -LiteralPath $env:RC_TEST_SERVICE_LOG -Value "stop $TaskName"
}
# Starting the task runs the launcher the installer just generated, which is the only way to find
# out whether it reads install-meta, resolves NODE_BIN and appends to agent.log. Publishing the
# versioned readiness signal is the agent's job, and the stub node.exe does not do it, so this
# stands in for it. RC_TEST_CONNECT=0 is a machine where the agent starts and never connects.
function Start-ScheduledTask {
  [CmdletBinding()] param([string]$TaskName)
  Add-Content -LiteralPath $env:RC_TEST_SERVICE_LOG -Value "start $TaskName"
  $rcHome = Join-Path $env:USERPROFILE '.runner-center'
  $launcher = Join-Path $rcHome 'start-agent.ps1'
  if (Test-Path -LiteralPath $launcher) {
    $here = Get-Location
    try { & $launcher } catch { Add-Content -LiteralPath $env:RC_TEST_SERVICE_LOG -Value "launcher failed: $_" }
    Set-Location $here
  }
  if ($env:RC_TEST_CONNECT -ne '1') { return }
  $manifest = Join-Path (Join-Path $rcHome 'agent') 'package.json'
  if (-not (Test-Path -LiteralPath $manifest)) { return }
  $version = (Get-Content -Raw -LiteralPath $manifest | ConvertFrom-Json).version
  Set-Content -LiteralPath (Join-Path $rcHome 'agent.ready') -Value $version
}


& $env:RC_TEST_SCRIPT @args
exit $LASTEXITCODE
`;

/** A Node.js that answers the one question the installer asks it, and an npm that records its argv. */
const NODE_STUB = `#!/usr/bin/env bash
if [ "$1" = "-p" ]; then printf '22\\n'; exit 0; fi
if [ "$1" = "--version" ]; then printf 'v22.0.0\\n'; exit 0; fi
printf 'agent stub running %s\\n' "$1"
exit 0
`;

const NPM_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_NPM_LOG"
if [ "$RC_TEST_NPM_FAIL" = "1" ]; then printf 'npm stub failure\\n' >&2; exit 1; fi
if [ "$1" = "ci" ]; then mkdir -p node_modules && printf 'installed\\n' > node_modules/.installed; fi
exit 0
`;

/** bsdtar under the name the installer looks for; icacls with nothing to enforce off NTFS. */
const TAR_STUB = `#!/usr/bin/env bash
exec /usr/bin/tar "$@"
`;
const ICACLS_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_ICACLS_LOG"
exit 0
`;

type WinSandbox = {
  root: string;
  home: string;
  rcHome: string;
  scriptPath: string;
  runnerPath: string;
  routesPath: string;
  binDir: string;
  fixtures: string;
  requestLog: string;
  npmLog: string;
  serviceLog: string;
  icaclsLog: string;
};

function createWinSandbox(release: AgentRelease, options: { withNode?: boolean } = {}): WinSandbox {
  const root = mkdtempSync(path.join(tmpdir(), "rc-win-install-"));
  sandboxes.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fixtures = path.join(root, "fixtures");
  for (const directory of [home, binDir, fixtures]) {
    mkdirSync(directory, { recursive: true });
  }
  expect(home, "the sandbox must not be the real home directory").not.toBe(homedir());

  if (options.withNode !== false) {
    writeExecutable(path.join(binDir, "node.exe"), NODE_STUB);
    writeExecutable(path.join(binDir, "npm.cmd"), NPM_STUB);
  }
  writeExecutable(path.join(binDir, "tar.exe"), TAR_STUB);
  writeExecutable(path.join(binDir, "icacls.exe"), ICACLS_STUB);

  const scriptPath = path.join(root, "install.ps1");
  writeFileSync(scriptPath, renderWindowsInstallScript(SITE_URL, release));
  const runnerPath = path.join(root, "runner.ps1");
  writeFileSync(runnerPath, RUNNER);
  const routesPath = path.join(root, "routes");
  writeFileSync(routesPath, "");

  return {
    root,
    home,
    rcHome: path.join(home, ".runner-center"),
    scriptPath,
    runnerPath,
    routesPath,
    binDir,
    fixtures,
    requestLog: path.join(root, "requests.log"),
    npmLog: path.join(root, "npm.log"),
    serviceLog: path.join(root, "service.log"),
    icaclsLog: path.join(root, "icacls.log"),
  };
}

function repin(sandbox: WinSandbox, release: AgentRelease) {
  writeFileSync(sandbox.scriptPath, renderWindowsInstallScript(SITE_URL, release));
}

function route(sandbox: WinSandbox, url: string, filePath: string, status = 200) {
  const existing = readFileSync(sandbox.routesPath, "utf8");
  writeFileSync(sandbox.routesPath, `${existing}${url}|${status}|${filePath}\n`);
}

/** A release archive shaped the way the packager produces one, plus its published checksum. */
function publishRelease(
  sandbox: WinSandbox,
  release: AgentRelease,
  marker: string,
  options: { digestOverride?: string } = {},
) {
  const stage = path.join(sandbox.fixtures, `stage-${release.version}`, "agent");
  mkdirSync(path.join(stage, "dist"), { recursive: true });
  mkdirSync(path.join(stage, "provisioners"), { recursive: true });
  writeFileSync(path.join(stage, "dist", "index.js"), `// ${marker}\n`);
  writeFileSync(path.join(stage, "package.json"), `{"version":"${release.version}"}\n`);
  writeFileSync(path.join(stage, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(stage, "provisioners", "provision-win.ps1"), "# provisioner\n");

  const assetName = `erainfra-agent-${release.version}.tar.gz`;
  const archivePath = path.join(sandbox.fixtures, assetName);
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", path.dirname(stage), "agent"]);
  expect(tar.status, tar.stderr?.toString()).toBe(0);

  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const checksumPath = `${archivePath}.sha256`;
  writeFileSync(checksumPath, `${options.digestOverride ?? sha256}  ${assetName}\n`);

  const base = `https://github.com/${release.repo}/releases/download/v${release.version}`;
  route(sandbox, `${base}/${assetName}`, archivePath);
  route(sandbox, `${base}/${assetName}.sha256`, checksumPath);
  return { sha256, archivePath };
}

function publishRegistration(sandbox: WinSandbox) {
  const responsePath = path.join(sandbox.fixtures, "register.json");
  writeFileSync(
    responsePath,
    JSON.stringify({ machineToken: MACHINE_TOKEN, convexUrl: "https://example.convex.cloud" }),
  );
  route(sandbox, `${SITE_URL}/agents/register`, responsePath);
}

function seedExistingInstall(sandbox: WinSandbox, version: string, marker: string) {
  const agentDir = path.join(sandbox.rcHome, "agent");
  mkdirSync(path.join(agentDir, "dist"), { recursive: true });
  writeFileSync(path.join(agentDir, "dist", "index.js"), `// ${marker}\n`);
  writeFileSync(path.join(agentDir, "package.json"), `{"version":"${version}"}\n`);
  writeFileSync(
    path.join(agentDir, ".env"),
    `CONVEX_URL=https://example.convex.cloud\nMACHINE_TOKEN=${MACHINE_TOKEN}\n`,
  );
  writeFileSync(
    path.join(sandbox.rcHome, "install-meta"),
    [
      `SITE_URL=${SITE_URL}`,
      "NODE_BIN=C:\\does\\not\\matter\\node.exe",
      "MACHINE_NAME=seeded-machine",
      "SERVICE_KIND=schtask",
      `AGENT_VERSION=${version}`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(sandbox.rcHome, "agent.log"), "");
}

function run(
  sandbox: WinSandbox,
  args: readonly string[],
  options: { connect?: boolean; npmFails?: boolean; script?: string; arch?: string } = {},
) {
  return spawnSync(PWSH ?? "pwsh", ["-NoProfile", "-File", sandbox.runnerPath, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${sandbox.binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox.home,
      USERPROFILE: sandbox.home,
      COMPUTERNAME: "WIN-TEST-01",
      USERNAME: "rcbuilder",
      USERDOMAIN: "WIN-TEST-01",
      PROCESSOR_ARCHITECTURE: options.arch ?? "AMD64",
      RC_TEST_SCRIPT: options.script ?? sandbox.scriptPath,
      RC_TEST_ROUTES: sandbox.routesPath,
      RC_TEST_REQUEST_LOG: sandbox.requestLog,
      RC_TEST_NPM_LOG: sandbox.npmLog,
      RC_TEST_SERVICE_LOG: sandbox.serviceLog,
      RC_TEST_ICACLS_LOG: sandbox.icaclsLog,
      RC_TEST_NPM_FAIL: options.npmFails === true ? "1" : "0",
      RC_TEST_CONNECT: options.connect === false ? "0" : "1",
    },
  });
}

function readLog(filePath: string) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function agentMarker(sandbox: WinSandbox, directory = "agent") {
  return readFileSync(path.join(sandbox.rcHome, directory, "dist", "index.js"), "utf8").trim();
}

function metaField(sandbox: WinSandbox, key: string) {
  return readFileSync(path.join(sandbox.rcHome, "install-meta"), "utf8")
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

const describeExecuted = PWSH === undefined ? describe.skip : describe;

describeExecuted("the Windows installer, executed", () => {
  it("parses as PowerShell", () => {
    const script = renderWindowsInstallScript(SITE_URL, AGENT_RELEASE);
    const check = spawnSync(
      PWSH ?? "pwsh",
      [
        "-NoProfile",
        "-Command",
        "$null = [ScriptBlock]::Create([Console]::In.ReadToEnd()); Write-Output 'ok'",
      ],
      { input: script, encoding: "utf8" },
    );
    expect(check.status, check.stderr).toBe(0);
  });

  it("installs the immutable release asset this deployment pins", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    const result = run(sandbox, ["-Role", "worker", "-Token", "rcreg_test", "-Name", "win-01"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(agentMarker(sandbox)).toBe("// new agent");
    expect(result.stdout).toContain("the checksum pinned by this EraInfra deployment");
    expect(readLog(sandbox.requestLog)).toContain(
      `https://github.com/${TEST_REPO}/releases/download/v1.4.2/erainfra-agent-1.4.2.tar.gz`,
    );
    expect(readLog(sandbox.npmLog)).toContain("ci --omit=dev --no-audit --no-fund");
  });

  // The whole point of KEY=value over JSON: two readers on two platforms parse it with a prefix
  // match, and this file is the contract between the installer, start-agent.ps1 and rc.ps1.
  it("writes install-meta as KEY=value with the keys the POSIX installer writes", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "meta agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    expect(run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]).status).toBe(0);
    const meta = readFileSync(path.join(sandbox.rcHome, "install-meta"), "utf8");
    expect(
      meta
        .trimEnd()
        .split("\n")
        .map((line) => line.split("=")[0]),
    ).toEqual(["SITE_URL", "NODE_BIN", "MACHINE_NAME", "SERVICE_KIND", "AGENT_VERSION"]);
    expect(meta).not.toContain("{");
    expect(metaField(sandbox, "SITE_URL")).toBe(SITE_URL);
    expect(metaField(sandbox, "AGENT_VERSION")).toBe("1.4.2");
    expect(metaField(sandbox, "SERVICE_KIND")).toBe("schtask");
    expect(metaField(sandbox, "MACHINE_NAME")).toBe("WIN-TEST-01");
  });

  it("registers this machine as a Windows x64 Worker and locks the credential down", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "registering agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    expect(run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]).status).toBe(0);
    const body = readLog(sandbox.requestLog)
      .split("\n")
      .find((line) => line.startsWith("BODY "));
    expect(body).toBeDefined();
    expect(JSON.parse((body ?? "").slice(5))).toMatchObject({
      registrationToken: "rcreg_test",
      os: "win",
      arch: "x86_64",
      cpus: 8,
    });
    const env = readFileSync(path.join(sandbox.rcHome, "agent", ".env"), "utf8");
    expect(env).toContain(`MACHINE_TOKEN=${MACHINE_TOKEN}`);
    // SIDs, not localised account names, and inheritance broken before the grant.
    expect(readLog(sandbox.icaclsLog)).toMatch(/\/inheritance:r/);
    expect(readLog(sandbox.icaclsLog)).toMatch(/\*S-1-5-18:\(OI\)\(CI\)\(F\)/);
  });

  // The loudest test in this file. A digest that does not match must stop the install dead, before
  // the running agent is touched, and say so in a way an operator cannot miss.
  it("refuses a mismatched digest loudly, and installs nothing", () => {
    const sandbox = createWinSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "tampered agent", { digestOverride: "f".repeat(64) });
    publishRegistration(sandbox);
    seedExistingInstall(sandbox, "1.3.0", "old agent");

    const result = run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("checksum verification failed");
    expect(result.stdout).toContain("Nothing was installed");
    expect(result.stdout).toContain("f".repeat(64));
    // Untouched: the old agent is still there, still on the bytes it was installed with.
    expect(agentMarker(sandbox)).toBe("// old agent");
    expect(existsSync(path.join(sandbox.rcHome, "agent.previous"))).toBe(false);
    expect(readLog(sandbox.npmLog)).toBe("");
    expect(readLog(sandbox.serviceLog)).toBe("");
  });

  // An archive the release vouches for, but this deployment's pin does not. That is the trust root,
  // and it is the case a plain checksum check would wave through.
  it("rejects an archive that the release vouches for but this deployment does not", () => {
    const sandbox = createWinSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "unpinned agent");
    repin(sandbox, { ...CURRENT, sha256: "d".repeat(64) });
    publishRegistration(sandbox);
    seedExistingInstall(sandbox, "1.3.0", "old agent");

    const result = run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      "does not match the checksum pinned by this EraInfra deployment",
    );
    expect(result.stdout).toContain("Nothing was installed");
    expect(agentMarker(sandbox)).toBe("// old agent");
  });

  it("keeps the replaced installation so a bad release can be recovered", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    seedExistingInstall(sandbox, "1.3.0", "old agent");

    expect(run(sandbox, ["-Role", "worker", "-Update"]).status).toBe(0);
    expect(agentMarker(sandbox)).toBe("// new agent");
    expect(agentMarker(sandbox, "agent.previous")).toBe("// old agent");
  });

  it("rolls back to the previous agent when the new one never connects", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "broken agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    seedExistingInstall(sandbox, "1.3.0", "old agent");

    const result = run(sandbox, ["-Role", "worker", "-Update"], { connect: false });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("rolled back to the previous installation");
    expect(agentMarker(sandbox)).toBe("// old agent");
    expect(metaField(sandbox, "AGENT_VERSION")).toBe("1.3.0");
  });

  it("carries the machine credentials across the replacement", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    seedExistingInstall(sandbox, "1.3.0", "old agent");

    expect(run(sandbox, ["-Role", "worker", "-Update"]).status).toBe(0);
    expect(readFileSync(path.join(sandbox.rcHome, "agent", ".env"), "utf8")).toContain(
      `MACHINE_TOKEN=${MACHINE_TOKEN}`,
    );
    expect(metaField(sandbox, "MACHINE_NAME")).toBe("seeded-machine");
  });

  it("refuses an update when no machine is registered yet", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });

    const result = run(sandbox, ["-Role", "worker", "-Update"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("No existing EraInfra registration was found");
  });

  it("refuses a historical release without an independently supplied checksum", () => {
    const sandbox = createWinSandbox(CURRENT);
    publishRelease(sandbox, OLDER, "older agent");
    seedExistingInstall(sandbox, "1.4.2", "current agent");

    const result = run(sandbox, ["-Role", "worker", "-Update", "-Version", "v1.3.0"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("requires -Sha256");
    expect(agentMarker(sandbox)).toBe("// current agent");
  });

  it("installs an older version when the operator supplies its independent checksum", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, OLDER, "older agent");
    seedExistingInstall(sandbox, "1.4.2", "current agent");

    const result = run(sandbox, [
      "-Role",
      "worker",
      "-Update",
      "-Version",
      "v1.3.0",
      "-Sha256",
      published.sha256,
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(agentMarker(sandbox)).toBe("// older agent");
  });

  it("refuses arguments that belong to the other role", () => {
    const sandbox = createWinSandbox(CURRENT);
    const worker = run(sandbox, ["-Role", "worker", "-Token", "t", "-Hub", "wss://h/agent"]);
    expect(worker.status).not.toBe(0);
    expect(worker.stdout).toContain("-Hub belongs to -Role node");

    const node = run(sandbox, ["-Role", "node", "-Token", "t", "-Slots", "2"]);
    expect(node.status).not.toBe(0);
    expect(node.stdout).toContain("-Slots belongs to -Role worker");
  });

  it("refuses malformed flag values before it touches the network", () => {
    const sandbox = createWinSandbox(CURRENT);
    for (const [args, message] of [
      [["-Slots", "0"], "-Slots must be a positive integer"],
      [["-Slots", "two"], "-Slots must be a positive integer"],
      [["-Version", "latest"], "-Version must be a release version"],
      [["-Sha256", "NOTHEX"], "-Sha256 must be a 64-character lowercase hex digest"],
    ] as const) {
      const result = run(sandbox, ["-Role", "worker", "-Token", "rcreg_test", ...args]);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.stdout).toContain(message);
    }
    expect(readLog(sandbox.requestLog)).toBe("");
  });

  it("refuses an unknown role", () => {
    const sandbox = createWinSandbox(CURRENT);
    const result = run(sandbox, ["-Role", "controller", "-Token", "t"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("Unknown -Role: controller");
  });

  it("refuses a host whose architecture no Windows image targets", () => {
    const sandbox = createWinSandbox(CURRENT);
    const result = run(sandbox, ["-Role", "worker", "-Token", "t"], { arch: "ARM64" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("onboards x64 Windows Workers only");
  });

  it("leaves the running agent in place when dependency installation fails", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    seedExistingInstall(sandbox, "1.3.0", "old agent");

    const result = run(sandbox, ["-Role", "worker", "-Update"], { npmFails: true });
    expect(result.status).not.toBe(0);
    expect(agentMarker(sandbox)).toBe("// old agent");
  });

  // The Node-runtime answer, executed: a host with no Node gets the official Node 22 build for
  // win-x64, checked against nodejs.org's own SHASUMS256.txt, before anything runs it.
  it("installs a checksum-verified Node.js runtime on a host that has none", () => {
    const sandbox = createWinSandbox(CURRENT, { withNode: false });
    const published = publishRelease(sandbox, CURRENT, "runtime-less host");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    // The shape nodejs.org publishes: a directory that unzips to node-v22.<x>-win-x64\node.exe.
    const nodeStage = path.join(sandbox.fixtures, "node-v22.23.2-win-x64");
    mkdirSync(nodeStage, { recursive: true });
    writeExecutable(path.join(nodeStage, "node.exe"), NODE_STUB);
    writeExecutable(path.join(nodeStage, "npm.cmd"), NPM_STUB);
    const nodeZip = path.join(sandbox.fixtures, "node-v22.23.2-win-x64.zip");
    const zip = spawnSync(PWSH ?? "pwsh", [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${nodeStage}' -DestinationPath '${nodeZip}' -Force`,
    ]);
    expect(zip.status, zip.stderr?.toString()).toBe(0);

    const nodeSha = createHash("sha256").update(readFileSync(nodeZip)).digest("hex");
    const shasums = path.join(sandbox.fixtures, "SHASUMS256.txt");
    writeFileSync(
      shasums,
      `${"9".repeat(64)}  node-v22.23.2-darwin-x64.tar.gz\n${nodeSha}  node-v22.23.2-win-x64.zip\n`,
    );
    route(sandbox, "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt", shasums);
    route(sandbox, "https://nodejs.org/dist/latest-v22.x/node-v22.23.2-win-x64.zip", nodeZip);

    const result = run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Installing the latest official Node.js 22 release");
    expect(existsSync(path.join(sandbox.rcHome, "node", "node.exe"))).toBe(true);
    expect(metaField(sandbox, "NODE_BIN")).toBe(path.join(sandbox.rcHome, "node", "node.exe"));
  });

  it("refuses a Node.js runtime whose bytes do not match nodejs.org's own checksum", () => {
    const sandbox = createWinSandbox(CURRENT, { withNode: false });
    const published = publishRelease(sandbox, CURRENT, "runtime-less host");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });

    const nodeZip = path.join(sandbox.fixtures, "node-v22.23.2-win-x64.zip");
    writeFileSync(nodeZip, "not really a zip");
    const shasums = path.join(sandbox.fixtures, "SHASUMS256.txt");
    writeFileSync(shasums, `${"e".repeat(64)}  node-v22.23.2-win-x64.zip\n`);
    route(sandbox, "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt", shasums);
    route(sandbox, "https://nodejs.org/dist/latest-v22.x/node-v22.23.2-win-x64.zip", nodeZip);

    const result = run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("The Node.js archive checksum verification failed");
    expect(result.stdout).toContain("Nothing was installed");
    expect(existsSync(path.join(sandbox.rcHome, "node"))).toBe(false);
  });

  it("writes a launcher and a CLI that both read install-meta, and both parse", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);
    expect(run(sandbox, ["-Role", "worker", "-Token", "rcreg_test"]).status).toBe(0);

    for (const generated of [
      path.join(sandbox.rcHome, "start-agent.ps1"),
      path.join(sandbox.rcHome, "bin", "rc.ps1"),
    ]) {
      const body = readFileSync(generated, "utf8");
      expect(body).toContain("install-meta");
      const parse = spawnSync(
        PWSH ?? "pwsh",
        [
          "-NoProfile",
          "-Command",
          "$null = [ScriptBlock]::Create([Console]::In.ReadToEnd()); Write-Output 'ok'",
        ],
        { input: body, encoding: "utf8" },
      );
      expect(parse.status, `${generated}: ${parse.stderr}`).toBe(0);
    }
    expect(readLog(sandbox.serviceLog)).toContain("register erainfra-action-runner-agent");
    expect(readLog(sandbox.serviceLog)).not.toContain("launcher failed");
    // Both service kinds have to produce one agent.log, because that is the file rc.ps1 reads and
    // the file the connection wait quotes back. A Scheduled Task redirects nothing at all, so the
    // launcher owns the redirect, and running it is the only way to prove the redirect works.
    const agentLog = readFileSync(path.join(sandbox.rcHome, "agent.log"), "utf8");
    expect(agentLog).toContain("agent stub running");
    expect(agentLog).toContain(path.join(sandbox.rcHome, "agent", "dist", "index.js"));
  });

  // The CLI reads the same KEY=value metadata the installer wrote, under the same stubs. Running it
  // is the only way to catch the shape of bug a parse cannot: `-Version` forwarded by ARRAY splat
  // binds positionally, so `update -Version v1.2.3` would put the flag name in -Token and go on.
  it("ships an rc.ps1 that reads install-meta and forwards update flags by name", () => {
    const sandbox = createWinSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);
    expect(
      run(sandbox, ["-Role", "worker", "-Token", "rcreg_test", "-Name", "win-01"]).status,
    ).toBe(0);

    const rcCli = path.join(sandbox.rcHome, "bin", "rc.ps1");
    const status = run(sandbox, ["status"], { script: rcCli });
    expect(status.status, status.stdout + status.stderr).toBe(0);
    expect(status.stdout).toContain("Machine: win-01");
    expect(status.stdout).toContain("Agent: 1.4.2");
    expect(status.stdout).toContain("Status: running");

    const cli = readFileSync(rcCli, "utf8");
    expect(cli).toMatch(/\$forward = @\{ Role = "worker"; Update = \$true \}/);
    expect(cli).toMatch(/& \$installer @forward/);
    expect(cli).not.toMatch(/@Rest/);
    expect(cli).not.toMatch(/ValueFromRemainingArguments/);
  });
});

/**
 * PSScriptAnalyzer is not a repository dependency either, so these skip when it is absent rather
 * than pretending the script was linted. The 5.1 profile is the load-bearing one: `pwsh` on this
 * machine is PowerShell 7, and it will happily parse syntax Windows PowerShell rejects.
 */
const describeAnalyzer = PWSH === undefined ? describe.skip : describe;

describeAnalyzer("PSScriptAnalyzer", () => {
  function analyze(command: string) {
    const result = spawnSync(PWSH ?? "pwsh", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
    });
    return result;
  }

  const hasAnalyzer =
    analyze(
      "if (Get-Module -ListAvailable PSScriptAnalyzer) { 'yes' } else { 'no' }",
    ).stdout.trim() === "yes";

  function scriptFile() {
    const root = mkdtempSync(path.join(tmpdir(), "rc-win-lint-"));
    sandboxes.push(root);
    const file = path.join(root, "install.ps1");
    writeFileSync(file, renderWindowsInstallScript(SITE_URL, AGENT_RELEASE));
    return file;
  }

  // Write-Host is this script's user interface, not a leaked debug statement, and the two
  // Start-/Stop-Agent helpers are private to a script rather than exported from a module — so
  // ShouldProcess would only add -WhatIf to something nothing pipes into. Everything else is a
  // finding this installer has to answer for.
  it.skipIf(!hasAnalyzer)("reports nothing outside the two documented exclusions", () => {
    const file = scriptFile();
    const result = analyze(
      `Import-Module PSScriptAnalyzer; $r = Invoke-ScriptAnalyzer -Path '${file}' -Severity Error,Warning -ExcludeRule PSAvoidUsingWriteHost,PSUseShouldProcessForStateChangingFunctions; if ($r) { $r | Format-List } else { Write-Output 'CLEAN' }`,
    );
    expect(result.stdout.trim(), result.stdout).toBe("CLEAN");
  });

  it.skipIf(!hasAnalyzer)("uses no syntax or cmdlet Windows PowerShell 5.1 lacks", () => {
    const file = scriptFile();
    const result = analyze(
      `Import-Module PSScriptAnalyzer
       $profiles = Get-ChildItem "$((Get-Module -ListAvailable PSScriptAnalyzer | Select-Object -First 1).ModuleBase)/compatibility_profiles" -Filter '*_5.1.*_framework.json' |
         Select-Object -ExpandProperty BaseName
       if (-not $profiles) { Write-Output 'NO PROFILE'; exit 0 }
       $settings = @{
         IncludeRules = @('PSUseCompatibleSyntax', 'PSUseCompatibleCommands')
         Rules = @{
           PSUseCompatibleSyntax = @{ Enable = $true; TargetVersions = @('5.1') }
           PSUseCompatibleCommands = @{ Enable = $true; TargetProfiles = @($profiles[0]) }
         }
       }
       $r = Invoke-ScriptAnalyzer -Path '${file}' -Settings $settings
       if ($r) { $r | Format-List } else { Write-Output 'CLEAN' }`,
    );
    expect(result.stdout.trim(), result.stdout).toBe("CLEAN");
  });
});
