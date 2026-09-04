// Static guards for the Windows provisioners.
//
// No Windows host, no Hyper-V and no PowerShell interpreter exist in CI or on a
// macOS workstation, so these are source-level assertions, not behavioural
// tests: they pin the specific regressions that were fixed rather than proving
// the scripts work. Behaviour is still unverified — see the PREVIEW notes at the
// top of each script.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function provisioner(name: string) {
  return readFileSync(new URL(`../provisioners/${name}`, import.meta.url), "utf8");
}

const provisionWin = provisioner("provision-win.ps1");
const buildImage = provisioner("build-image.ps1");
const provisionLinux = provisioner("provision-linux.sh");
const provisionMac = provisioner("provision-mac.sh");
const provisionDocker = provisioner("provision-docker.sh");
const agentSource = readFileSync(new URL("../provision.ts", import.meta.url), "utf8");
const readinessSource = readFileSync(new URL("../readiness.ts", import.meta.url), "utf8");

// The runner archive pin, shared by the checksum and drift tests below.
const PINNED_RUNNER_VERSION = "2.336.0";
const PINNED_RUNNER_SHA256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162";

// The tooling pins, in the same shape: a version, a digest of the vendor's own
// artifact, and nothing resolved at build time.
const PINNED_GIT_VERSION = "2.55.0";
const PINNED_GIT_WINDOWS_REVISION = "4";
const PINNED_GIT_SHA256 = "0cbc0b34a74b3aff3ace0910328549155a770e228331b19cb1498218a120e7ff";
const PINNED_NODE_VERSION = "24.19.0";
const PINNED_NODE_SHA256 = "f0f66c2a80c08a30a5ab5179ee9ea9e45f9b46289436a8cc87ff833b852db351";
const PINNED_PYTHON_VERSION = "3.13.15";
const PINNED_PYTHON_SHA256 = "edec09c4853aeae9ac36efb8c9f95b6b8e2fee65eee56d9767a8b7c69c574403";

// The guest half of build-image.ps1 is a single-quoted here-string, so the
// builder expands nothing inside it and it can be read as its own program.
// Every assertion about what runs on the guest is made against this slice.
const guestScript = (() => {
  const start = buildImage.indexOf("$provisionBody = @'");
  const end = buildImage.indexOf("\n'@", start);
  if (start < 0 || end < start) throw new Error("build-image.ps1 has no guest here-string");
  return buildImage.slice(start, end);
})();

// These scripts explain themselves in comments that quote the very literals
// some assertions forbid, so anything asserting about what the script *does*
// reads the code with the prose removed.
function codeOf(source: string) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

const buildImageCode = codeOf(buildImage);
const guestCode = codeOf(guestScript);

describe("provision-mac.sh capacity guard", () => {
  it("takes an atomic host slot and refuses to exceed the configured allowance", () => {
    assert.match(provisionMac, /if mkdir "\$candidate"/);
    assert.match(provisionMac, /All \$MAX_CONCURRENT_VMS Tart VM slots are occupied/);
    assert.match(provisionMac, /rmdir "\$SLOT_DIR"/);
    assert.doesNotMatch(provisionMac, /Apple's macOS SLA permits.*warn/);
  });

  it("validates every timeout and capacity value before arithmetic", () => {
    for (const name of [
      "RC_BOOT_TIMEOUT_S",
      "RC_MAC_ATTEST_TIMEOUT_S",
      "RC_MAC_MAX_CONCURRENT_VMS",
    ]) {
      assert.match(provisionMac, new RegExp(`require_positive_integer ${name}`));
    }
    assert.match(provisionMac, /require_nonnegative_integer RC_JOB_TIMEOUT_S/);
  });
});

describe("provision-docker.sh isolation contract", () => {
  it("uses a prewarmed immutable image with CPU, memory and process limits", () => {
    assert.match(provisionDocker, /--pull=never/);
    assert.match(provisionDocker, /--cpus "\$RC_VCPUS"/);
    assert.match(provisionDocker, /--memory "\$\{RC_MEMORY_MIB\}m"/);
    assert.match(provisionDocker, /--pids-limit "\$RC_PIDS_LIMIT"/);
    assert.match(provisionDocker, /RC_PIDS_LIMIT=4096/);
    assert.match(provisionDocker, /--user runner/);
  });

  // #96: every rlimit and the resolver were the Docker daemon's inherited
  // defaults. Each is now a flag with the reason it was chosen written beside
  // it, and the ones deliberately left alone say so in the same place.
  it("sets each resource limit deliberately and says why", () => {
    for (const flag of [
      /--ulimit core=0:0/,
      /--ulimit stack=16777216:-1/,
      /--ulimit nofile=65536:1048576/,
      /--ulimit memlock=8388608:8388608/,
      /--ulimit "nproc=\$\{RC_NPROC_MAX\}:\$\{RC_NPROC_MAX\}"/,
    ]) {
      assert.match(provisionDocker, flag);
    }
    // The bound scales with the Profile rather than with the Worker's RAM.
    assert.match(provisionDocker, /RC_NPROC_MAX=\$\(\(RC_MEMORY_MIB \* 4\)\)/);
    // Not every difference becomes a flag, but every one becomes a record.
    assert.match(provisionDocker, /sigpending/);
    assert.match(provisionDocker, /host-sysctls/);
  });

  // None of #96's sysctls is namespaced, so `docker run --sysctl` refuses all
  // six and passing one would fail every Attempt outright. They are a Worker
  // prerequisite that readiness proves instead.
  it("never passes a sysctl the daemon would refuse", () => {
    assert.doesNotMatch(provisionDocker, /--sysctl [^ ]/);
  });

  // The resolver a job gets is named on the command line rather than whatever
  // the daemon inherited, and a bare name may not resolve through a suffix the
  // Worker's network happens to supply.
  it("decides the resolver shape instead of inheriting it", () => {
    assert.match(provisionDocker, /dns_flags\+=\(--dns-option edns0\)/);
    assert.match(provisionDocker, /dns_flags\+=\(--dns-search \.\)/);
    assert.match(provisionDocker, /"\$\{dns_flags\[@\]\}"/);
    // trust-ad asks the stub to believe an AD bit from a resolver we do not own.
    assert.doesNotMatch(provisionDocker, /dns_flags\+=\(--dns-option trust-ad\)/);
    assert.match(provisionDocker, /set RC_DNS_SERVERS/);
  });

  // Regression (#80): --cpus sets only the CFS bandwidth quota, so nproc(1),
  // os.availableParallelism(), runtime.NumCPU(), os.cpu_count() and
  // Runtime.availableProcessors() all kept reading the host's affinity mask and
  // every autosizing build tool over-subscribed by the ratio between them.
  it("pins the container to the core range the Agent reserved for it", () => {
    assert.match(provisionDocker, /--cpuset-cpus "\$RC_CPUSET_CPUS"/);
    assert.match(provisionDocker, /RC_CPUSET_CPUS:\?RC_CPUSET_CPUS is required/);
    assert.match(provisionDocker, /RC_CPUSET_CPUS covers %s CPUs but RC_VCPUS is %s/);
  });

  // The cpuset makes every CPU interface honest; /proc/meminfo stays the
  // host's. The limit is exported so the truth is at least available, and the
  // decision not to mount LXCFS is written down where the flags are.
  it("tells the job its memory limit, which /proc/meminfo will not", () => {
    assert.match(provisionDocker, /--env "RC_MEMORY_MIB=\$RC_MEMORY_MIB"/);
    assert.match(provisionDocker, /--env "RC_VCPUS=\$RC_VCPUS"/);
    assert.match(provisionDocker, /LXCFS/);
  });

  it("passes JIT through a FIFO, never argv, host env, or a regular file", () => {
    assert.match(provisionDocker, /mkfifo "\$WORKDIR\/runner\.env"/);
    assert.match(provisionDocker, /--env-file "\$WORKDIR\/runner\.env"/);
    assert.doesNotMatch(provisionDocker, /export ACTIONS_RUNNER_INPUT_JITCONFIG/);
    assert.doesNotMatch(provisionDocker, /--env ACTIONS_RUNNER_INPUT_JITCONFIG/);
  });

  it("never exposes the Docker socket or a host bind mount", () => {
    assert.doesNotMatch(provisionDocker, /docker\.sock|--privileged|--volume|-v \/|type=bind/);
  });

  // A named volume shared by every job on a Profile is a cross-job cache
  // poisoning path: one job writes a compromised package into the store and
  // the next job installs it. Nothing writable may outlive a container.
  it("shares no writable storage between jobs", () => {
    assert.doesNotMatch(provisionDocker, /--mount|--volume|type=volume/);
    assert.doesNotMatch(provisionDocker, /runner-cache/);
  });
});

describe("runner failure reporting", () => {
  // Regression: every provisioner launched the runner through upstream's
  // run.sh / run.cmd wrapper. Those wrappers drive a long-lived service, so
  // run-helper maps "listener exited with a terminated error" onto exit 0 --
  // stop, do not retry. On a one-shot ephemeral runner that turned every
  // startup failure into a job the control plane recorded as exitCode 0.
  const launchers = [
    ["provision-linux.sh", provisionLinux, /\.\/bin\/Runner\.Listener run &/],
    ["provision-docker.sh", provisionDocker, /\.\/bin\/Runner\.Listener run &/],
    ["provision-mac.sh", provisionMac, /exec \.\/bin\/Runner\.Listener run/],
    ["provision-win.ps1", provisionWin, /Join-Path \$RunnerRoot 'bin\\Runner\.Listener\.exe'/],
  ] as const;

  for (const [name, source, launch] of launchers) {
    it(`${name} invokes the listener directly`, () => {
      assert.match(source, launch);
    });
  }

  it("launches no provisioner through the exit-code-swallowing wrappers", () => {
    for (const [name, source] of launchers) {
      for (const line of source.split("\n")) {
        if (/^\s*#/.test(line)) continue;
        assert.doesNotMatch(line, /(^|[\s'"/\\])run\.(sh|cmd)\b/, `${name}: ${line.trim()}`);
      }
    }
  });

  // The runner is unpacked and then launched, so the check that the archive
  // was usable has to name the binary that is actually executed.
  it("asserts the unpacked macOS runner ships the listener", () => {
    assert.match(provisionMac, /if \[ ! -x "\\\$runner_dir\/bin\/Runner\.Listener" \]/);
  });
});

describe("provision-win.ps1 exit codes", () => {
  // Regression: the guest script ended with `return $LASTEXITCODE` while
  // `& run.cmd` was also writing to the pipeline, so Invoke-Command handed back
  // every line of runner output plus the code, and `exit [int] $exitCode` threw
  // on the resulting array instead of reporting the job's result.
  it("does not return a bare $LASTEXITCODE through the remoting pipeline", () => {
    assert.doesNotMatch(provisionWin, /^\s*return \$LASTEXITCODE\s*$/m);
  });

  it("keeps runner output off the pipeline that carries the exit code", () => {
    assert.match(provisionWin, /& \$runner run 2>&1 \| ForEach-Object \{ Write-Host \$_ \}/);
  });

  it("selects the exit-code record by shape instead of by position", () => {
    assert.match(provisionWin, /PSObject\.Properties\['RcExitCode'\]/);
    assert.match(provisionWin, /exit \[int\] \$exitRecord\.RcExitCode/);
  });

  it("fails loudly when the guest returns no exit code at all", () => {
    assert.match(provisionWin, /throw "The guest on \$runnerName returned no runner exit code\."/);
  });
});

describe("provision-win.ps1 secret handling", () => {
  // Regression: the guest ran `run.cmd --jitconfig $jit`, so the one-shot
  // registration sat in the guest's process list where a workflow step could
  // read it back.
  it("never puts the JIT configuration on a command line", () => {
    assert.doesNotMatch(provisionWin, /--jitconfig/);
  });

  it("reads the JIT configuration from stdin, never from the environment", () => {
    assert.match(provisionWin, /\[Console\]::In\.ReadToEnd\(\)/);
    assert.doesNotMatch(provisionWin, /\bJIT_CONFIG\b/);
  });

  it("passes the JIT configuration over the remoting socket instead", () => {
    assert.match(provisionWin, /-ArgumentList \$jitConfig, \$RunnerRoot/);
  });

  // The guest hands it to the runner through the one non-argv input upstream
  // accepts, and clears it again, rather than unpacking the blob into the
  // runner's own config files — that duplicated logic owned by the runner and
  // had to be re-checked against its source on every version bump.
  it("gives the runner ACTIONS_RUNNER_INPUT_JITCONFIG and clears it afterwards", () => {
    assert.match(provisionWin, /\$env:ACTIONS_RUNNER_INPUT_JITCONFIG = \$Jit/);
    assert.match(provisionWin, /\} finally \{\s*\$env:ACTIONS_RUNNER_INPUT_JITCONFIG = \$null/);
  });

  it("no longer materialises the blob as runner config files", () => {
    // DPAPI appears only to Unprotect the stored guest credential; the JIT
    // blob itself is never encrypted into a file the runner has to unpack.
    assert.doesNotMatch(provisionWin, /ProtectedData\]::Protect\(/);
    assert.doesNotMatch(provisionWin, /WriteAllBytes/);
  });

  // Regression (#89): the credential was user-scope DPAPI (Export-Clixml),
  // written by the interactive administrator who built the image but read by
  // the agent running as LocalSystem under its service wrapper -- a boundary
  // user-scope DPAPI cannot cross, so every provision failed at credential
  // resolution with an error that read like a corrupt file.
  it("reads the machine-scope DPAPI credential the image builder writes", () => {
    assert.match(provisionWin, /\$image\.cred\.json/);
    assert.match(provisionWin, /DataProtectionScope\]::LocalMachine/);
    assert.match(provisionWin, /ProtectedData\]::Unprotect\(/);
  });

  // <image>.cred.xml is a file a deployed Worker already holds, so it is retired
  // by dual-read (CONTEXT.md rule 4): the machine-scope file wins, the legacy
  // one is read only when it is the only one there, and the builder never
  // writes it again.
  it("falls back to the legacy user-scope credential and names the true cause", () => {
    const code = codeOf(provisionWin);
    const json = code.indexOf('$credJson = Join-Path $imageDir "$image.cred.json"');
    const xml = code.indexOf('$credXml = Join-Path $imageDir "$image.cred.xml"');
    const legacyRead = code.indexOf("Import-Clixml -LiteralPath $credXml");
    assert.ok(json > 0, "the machine-scope credential is not consulted");
    assert.ok(xml > json, "the legacy credential is consulted before the machine-scope one");
    assert.ok(legacyRead > xml, "the legacy credential is never read");
    assert.equal(code.split("Import-Clixml").length - 1, 1, "Import-Clixml outside the fallback");
    assert.match(provisionWin, /written by a different account than this agent runs as/);
    assert.doesNotMatch(buildImageCode, /cred\.xml/);
    assert.doesNotMatch(buildImageCode, /Export-Clixml/);
  });

  it("never writes the JIT configuration or a password to output", () => {
    for (const line of provisionWin.split("\n")) {
      if (!/Write-(Host|Output|Error|Warning)/.test(line)) continue;
      assert.doesNotMatch(line, /\$jitConfig|\$Jit\b|\$password|\$credential/, line.trim());
    }
  });
});

describe("provision-win.ps1 cleanup", () => {
  it("tears the VM and its differencing disk down in a finally block", () => {
    const finallyBlock = provisionWin.slice(provisionWin.lastIndexOf("} finally {"));
    assert.match(finallyBlock, /Remove-VM -Name \$runnerName -Force/);
    assert.match(finallyBlock, /Remove-Item -LiteralPath \$vmDir -Recurse -Force/);
    assert.match(finallyBlock, /Stop-Job -Job \$job/);
    assert.match(finallyBlock, /Remove-PSSession -Session \$session/);
  });

  it("also cleans up when the engine exits past the finally block", () => {
    assert.match(provisionWin, /Register-EngineEvent -SourceIdentifier PowerShell\.Exiting/);
    assert.match(provisionWin, /\$global:RcCleanupVmName = \$null/);
  });

  it("reaps orphans left by a run that was killed outright", () => {
    assert.match(provisionWin, /function Remove-RcOrphan\(/);
    assert.match(provisionWin, /\$orphans = @\(Remove-RcOrphan \$vmRoot \$orphanMaxAgeMin\)/);
  });

  it("keeps the orphan cutoff above GitHub's six-hour job ceiling", () => {
    const match = /Get-PositiveIntEnv 'ORPHAN_MAX_AGE_MIN' (\d+)/.exec(provisionWin);
    assert.ok(match, "ORPHAN_MAX_AGE_MIN has no default");
    assert.ok(Number(match[1]) > 360, "a live six-hour job could be reaped");
  });
});

describe("provision-win.ps1 timeouts", () => {
  it("bounds both the boot wait and the runner itself", () => {
    assert.match(provisionWin, /Get-TimeoutEnv 'RC_BOOT_TIMEOUT_S' 'BOOT_TIMEOUT_S' \d+/);
    assert.match(provisionWin, /Get-TimeoutEnv 'RC_JOB_TIMEOUT_S' 'JOB_TIMEOUT_S' \d+/);
  });

  // A timeout has to be distinguishable from a failed job, so every provisioner
  // reports it as 124 rather than throwing into a generic non-zero exit.
  it("reports a job that outlives its budget as 124", () => {
    assert.match(provisionWin, /exceeded RC_JOB_TIMEOUT_S/);
    assert.match(provisionWin, /^\s*exit 124$/m);
    assert.doesNotMatch(provisionWin, /throw "Timed out after \$\{jobTimeout\}s/);
  });

  it("rejects non-numeric timeout and sizing input", () => {
    assert.match(provisionWin, /function Get-PositiveIntEnv/);
    assert.match(provisionWin, /must be a positive integer/);
  });

  it("rejects names that could escape the vms directory", () => {
    assert.match(provisionWin, /Assert-SafeName \$runnerName 'RUNNER_NAME'/);
    assert.match(provisionWin, /Assert-SafeName \$image 'IMAGE'/);
  });
});

describe("build-image.ps1 runner pin", () => {
  // Regression: the image builder resolved releases/latest at build time, so
  // two images built a week apart contained different runners and neither was
  // verified against a checksum.
  it("does not resolve the runner from releases/latest", () => {
    assert.doesNotMatch(buildImage, /releases\/latest/);
    assert.doesNotMatch(buildImage, /api\.github\.com/);
  });

  it("pins an explicit version and SHA-256", () => {
    assert.match(buildImage, new RegExp(`\\$RunnerVersion = '${PINNED_RUNNER_VERSION}'`));
    assert.match(buildImage, new RegExp(`\\$RunnerSha256 = '${PINNED_RUNNER_SHA256}'`));
  });

  it("validates the pin before it is interpolated into the guest script", () => {
    assert.match(buildImage, /\$RunnerVersion -notmatch '\^\\d\+\\\.\\d\+\\\.\\d\+\$'/);
    assert.match(buildImage, /\$RunnerSha256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/);
  });

  it("verifies the downloaded archive and refuses to expand a mismatch", () => {
    const download = buildImage.indexOf("Invoke-WebRequest -Uri $url");
    const expand = buildImage.indexOf("Expand-Archive");
    const hash = buildImage.indexOf("Get-FileHash -Path $zip -Algorithm SHA256");
    assert.ok(hash > download && hash < expand, "the checksum is not verified before expanding");
    assert.match(buildImage, /SHA-256 mismatch: expected \$RcRunnerSha256, got \$actualSha/);
  });

  it("stays in step with the Linux provisioner's runner pin", () => {
    assert.match(
      provisionLinux,
      new RegExp(`actions-runner:${PINNED_RUNNER_VERSION.replaceAll(".", "\\.")}`),
      "the Linux and Windows runner pins have drifted apart",
    );
  });
});

describe("build-image.ps1 tooling pin", () => {
  // Regression (#48): git, node and python were installed "best effort"
  // through a package manager that ships on no Windows Server SKU, with the
  // exit code logged and never checked. On Server 2022 the else branch ran, the
  // completion marker was written anyway, and the builder blessed a parent
  // image carrying the runner and no git -- so every job scheduled onto it died
  // at its first actions/checkout with nothing in the build log to explain it.
  it("installs nothing through a package manager that may not exist", () => {
    assert.doesNotMatch(buildImage, /winget/);
    assert.doesNotMatch(
      buildImage,
      /Get-Command \w+ -ErrorAction SilentlyContinue\) \{[\s\S]{0,80}install/,
    );
  });

  // #48 proposed resolving node from nodejs.org/dist/index.json and "the newest
  // matching installer" under python.org/ftp. That is releases/latest by
  // another name -- the exact regression the runner pin above exists to
  // prevent, one tool over. python.org/ftp cannot be forbidden outright, since
  // the pinned installer lives under it; what is forbidden is asking a vendor
  // which version to take, so every vendor URL has to name a pinned version.
  it("asks no vendor which version to install", () => {
    assert.doesNotMatch(buildImage, /nodejs\.org\/dist\/index\.json/);
    assert.doesNotMatch(buildImage, /releases\/latest/);
    assert.doesNotMatch(buildImage, /api\.github\.com/);
    const urls = buildImageCode.match(/https:\/\/[^"'\s)]+/g) ?? [];
    const vendor = urls.filter((url) => /nodejs\.org|python\.org|github\.com/.test(url));
    assert.equal(
      vendor.length,
      4,
      `expected one URL per pinned artifact, got ${vendor.join(", ")}`,
    );
    for (const url of vendor) {
      assert.match(url, /\$Rc\w+Version/, `resolved at build time rather than pinned: ${url}`);
    }
  });

  it("pins an explicit version and SHA-256 for each tool", () => {
    assert.match(buildImage, new RegExp(`\\$GitVersion = '${PINNED_GIT_VERSION}'`));
    assert.match(buildImage, new RegExp(`\\$GitWindowsRevision = ${PINNED_GIT_WINDOWS_REVISION}`));
    assert.match(buildImage, new RegExp(`\\$GitSha256 = '${PINNED_GIT_SHA256}'`));
    assert.match(buildImage, new RegExp(`\\$NodeVersion = '${PINNED_NODE_VERSION}'`));
    assert.match(buildImage, new RegExp(`\\$NodeSha256 = '${PINNED_NODE_SHA256}'`));
    assert.match(buildImage, new RegExp(`\\$PythonVersion = '${PINNED_PYTHON_VERSION}'`));
    assert.match(buildImage, new RegExp(`\\$PythonSha256 = '${PINNED_PYTHON_SHA256}'`));
  });

  // A digest nobody obtained is worse than no digest at all: it reads as
  // verification while proving that the artifact is whatever arrives.
  it("pins digests, not placeholders", () => {
    for (const [tool, sha] of [
      ["git", PINNED_GIT_SHA256],
      ["node", PINNED_NODE_SHA256],
      ["python", PINNED_PYTHON_SHA256],
    ] as const) {
      assert.match(sha, /^[0-9a-f]{64}$/, `the ${tool} digest is not 64 lowercase hex characters`);
      assert.ok(new Set(sha).size > 8, `the ${tool} digest looks like a placeholder`);
    }
  });

  it("validates every pin before it is interpolated into the guest script", () => {
    assert.match(buildImage, /\$GitVersion -notmatch '\^\\d\+\\\.\\d\+\\\.\\d\+\$'/);
    assert.match(buildImage, /\$NodeVersion -notmatch '\^\\d\+\\\.\\d\+\\\.\\d\+\$'/);
    assert.match(buildImage, /\$PythonVersion -notmatch '\^\\d\+\\\.\\d\+\\\.\\d\+\$'/);
    assert.match(buildImage, /\$GitSha256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/);
    assert.match(buildImage, /\$NodeSha256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/);
    assert.match(buildImage, /\$PythonSha256 -notmatch '\^\[0-9a-fA-F\]\{64\}\$'/);
    const injected = buildImage.indexOf('$provisionPrelude = @"');
    assert.ok(injected > 0, "the guest prelude is gone");
    for (const check of [
      "$GitVersion -notmatch",
      "$GitWindowsRevision -lt 1",
      "$GitSha256 -notmatch",
      "$NodeVersion -notmatch",
      "$NodeSha256 -notmatch",
      "$PythonVersion -notmatch",
      "$PythonSha256 -notmatch",
    ]) {
      const at = buildImage.indexOf(check);
      assert.ok(at > 0 && at < injected, `${check} runs after the value reaches the guest`);
    }
  });

  it("hashes every download between fetching it and using it", () => {
    const helper = guestCode.slice(
      guestCode.indexOf("function Save-RcPinnedDownload"),
      guestCode.indexOf("function Install-RcPinnedTool"),
    );
    const fetch = helper.indexOf("Invoke-WebRequest -Uri $Url -OutFile $Path");
    const hash = helper.indexOf("Get-FileHash -Path $Path -Algorithm SHA256");
    const refuse = helper.indexOf("SHA-256 mismatch: expected $Sha256, got $actual");
    assert.ok(fetch >= 0, "the helper does not download");
    assert.ok(hash > fetch, "the helper hashes before it downloads");
    assert.ok(refuse > hash, "the helper does not refuse a mismatch");
    assert.match(helper, /Remove-Item \$Path -Force -ErrorAction SilentlyContinue/);

    for (const [tool, sha] of [
      ["git", "$RcGitSha256"],
      ["node", "$RcNodeSha256"],
      ["python", "$RcPythonSha256"],
    ] as const) {
      const verified = guestScript.indexOf(
        `Save-RcPinnedDownload $${tool}Url $${tool}Installer ${sha}`,
      );
      const installed = guestScript.indexOf(`Install-RcPinnedTool '${tool}'`);
      assert.ok(verified > 0, `${tool} is not fetched through the verifying helper`);
      assert.ok(installed > verified, `${tool} is installed before its digest is checked`);
    }
    // The runner archive keeps its own inline check; nothing else may fetch.
    assert.equal(guestCode.split("Invoke-WebRequest").length - 1, 2);
  });

  // The other half of #48's complaint: $ErrorActionPreference does not apply to
  // native exit codes. These installers are also GUI-subsystem binaries, which
  // the call operator does not wait for, so the code has to be read off a
  // process that was waited on -- an exit code from a process still running is
  // the same missing measurement in a different disguise.
  it("waits for every installer and checks the code it returned", () => {
    assert.match(
      guestScript,
      /Start-Process -FilePath \$Program -ArgumentList \$ArgumentList -Wait -PassThru/,
    );
    assert.match(guestScript, /\$code = \$process\.ExitCode/);
    assert.match(guestScript, /if \(\$code -ne 0 -and \$code -ne 3010\) \{/);
    assert.match(guestScript, /throw "the \$Name installer exited with \$code"/);
    for (const line of buildImage.split("\n")) {
      if (!/Start-Process/.test(line) || /^\s*#/.test(line)) continue;
      assert.match(line, /-Wait/, `an installer is started without waiting: ${line.trim()}`);
    }
  });

  // Installer PATH edits are visible only to sessions started afterwards, so
  // probing this process's $env:PATH would prove nothing about the image. The
  // @(...) wrap and the .Count test are load-bearing: a one-element pipeline
  // result is not an array, so -not $found misreads the case that matters.
  it("proves each tool reached the machine PATH, not this session's", () => {
    assert.match(guestScript, /\[Environment\]::GetEnvironmentVariable\('Path', 'Machine'\)/);
    assert.match(guestScript, /foreach \(\$tool in \$pinnedTools\)/);
    for (const exe of ["git.exe", "node.exe", "python.exe"]) {
      assert.match(guestScript, new RegExp(`Exe = '${exe.replace(".", "\\.")}'`));
    }
    assert.match(guestScript, /\$found = @\(\$machinePath\.Split\(';'\)/);
    assert.match(
      guestScript,
      /if \(\$found\.Count -eq 0\) \{ throw "\$exe is not on the machine PATH after provisioning" \}/,
    );
    assert.doesNotMatch(guestCode, /\$env:PATH/);
  });

  it("records the version and the path of everything it installed", () => {
    assert.match(guestScript, /\$reported = @\(& \$resolved --version\)/);
    assert.match(guestScript, /"\$exe -> \$resolved \(\$\(\$reported\[0\]\)\)"/);
    assert.match(buildImage, /gitVersion = "\$GitVersion\.windows\.\$GitWindowsRevision"/);
    assert.match(buildImage, /gitSha256 = \$GitSha256\.ToLowerInvariant\(\)/);
    assert.match(buildImage, /nodeVersion = \$NodeVersion/);
    assert.match(buildImage, /nodeSha256 = \$NodeSha256\.ToLowerInvariant\(\)/);
    assert.match(buildImage, /pythonVersion = \$PythonVersion/);
    assert.match(buildImage, /pythonSha256 = \$PythonSha256\.ToLowerInvariant\(\)/);
  });

  // A tool that answers is not necessarily the tool that was pinned. An
  // installer that no-ops over an existing copy still exits 0, and a base image
  // that already carried the tool would leave it first on the machine PATH --
  // and the manifest would then record a version the image does not have, which
  // is the same lie as recording one it does not carry at all. Raised by
  // CodeRabbit on #85 and confirmed on the merits.
  it("rejects a tool whose reported version is not the pinned one", () => {
    assert.match(
      guestCode,
      /Exe = 'git\.exe'; Version = "\$RcGitVersion\.windows\.\$RcGitWindowsRevision"/,
    );
    assert.match(guestCode, /Exe = 'node\.exe'; Version = "v\$RcNodeVersion"/);
    assert.match(guestCode, /Exe = 'python\.exe'; Version = \$RcPythonVersion/);
    assert.match(
      guestCode,
      /if \(\$reported\.Count -eq 0 -or \$reported\[0\] -notlike "\*\$\(\$tool\.Version\)\*"\) \{/,
    );
    assert.match(
      guestCode,
      /throw "\$resolved reports '\$\(\$reported\[0\]\)', not the pinned \$\(\$tool\.Version\)"/,
    );

    // Every name in the loop carries a version, so a tool cannot be added with
    // nothing to check it against -- a lookup that missed would compare against
    // an empty pattern, which matches everything.
    const names = [...guestCode.matchAll(/Exe = '([^']+)'/g)].map((m) => m[1]);
    const versions = [...guestCode.matchAll(/Exe = '[^']+'; Version = /g)];
    assert.deepEqual(names, ["git.exe", "node.exe", "python.exe"]);
    assert.equal(versions.length, names.length);

    // And it runs before the image is blessed.
    const check = guestCode.indexOf("not the pinned");
    const marker = guestCode.indexOf("New-Item -ItemType File -Path 'C:\\rc-provision-complete'");
    assert.ok(check > 0, "nothing compares the reported version against the pin");
    assert.ok(marker > check, "the version check runs after the image is blessed");
  });

  // #48 restated as an invariant, and the test that matters most here: the
  // bless marker is a claim that the image carries what it promises, so no
  // path through the guest may reach it with a tool missing.
  it("cannot write the bless marker when a tool is missing", () => {
    const missing = guestCode.indexOf("is not on the machine PATH after provisioning");
    const marker = guestCode.indexOf("New-Item -ItemType File -Path 'C:\\rc-provision-complete'");
    const failed = guestCode.indexOf("} catch {");
    assert.ok(missing > 0, "nothing asserts that a tool arrived");
    assert.ok(marker > missing, "the marker is written before the tools are proven");
    assert.ok(failed > marker, "the marker is written outside the guarded block");

    for (const tool of ["'git'", "'node'", "'python'"]) {
      const installed = guestCode.indexOf(`Install-RcPinnedTool ${tool}`);
      assert.ok(installed > 0 && installed < marker, `${tool} is installed after the marker`);
    }

    // The one failure path writes the failure marker and nothing else, and the
    // completion marker is written in exactly one place.
    const onFailure = guestCode.slice(failed);
    assert.doesNotMatch(onFailure, /rc-provision-complete/);
    assert.match(onFailure, /rc-provision-failed/);
    assert.equal(guestCode.split("rc-provision-complete").length - 1, 1);

    // And the host still refuses to bless an image whose guest never got there.
    assert.match(buildImage, /\$ok = \(Test-Path "\$\{osDrive\}:\\rc-provision-complete"\)/);
    assert.match(buildImage, /if \(-not \$ok\) \{\s*\n\s*throw /);
  });
});

describe("build-image.ps1 image secrets", () => {
  // Regression: the image was built with an unattend AutoLogon block, which
  // Windows persists as a plaintext password under HKLM\...\Winlogon, and the
  // unattend file itself was left in the finished image.
  it("configures no AutoLogon at all", () => {
    assert.doesNotMatch(buildImage, /<AutoLogon>/);
    assert.doesNotMatch(buildImage, /<FirstLogonCommands>/);
  });

  it("provisions from SetupComplete.cmd instead of a first logon", () => {
    assert.match(buildImage, /SetupComplete\.cmd/);
  });

  it("scrubs the unattend copies and any AutoLogon values it finds", () => {
    assert.match(buildImage, /Remove-ItemProperty -Path \$winlogon -Name \$name/);
    assert.match(buildImage, /'AutoAdminLogon', 'DefaultUserName', 'DefaultPassword'/);
    assert.match(buildImage, /'C:\\Windows\\Panther\\unattend\.xml'/);
  });

  it("refuses to bless an image that still carries build-time credentials", () => {
    assert.match(buildImage, /if \(\$unattendLeft\) \{\s*\n\s*throw /);
    assert.match(buildImage, /if \(\$autoLogonLeft -eq \$true\) \{\s*\n\s*throw /);
  });

  it("gives the built-in Administrator a throwaway password and disables it", () => {
    assert.match(buildImage, /\$administratorPassword = New-RandomPassword/);
    assert.match(buildImage, /net\.exe user Administrator \/active:no/);
    assert.doesNotMatch(buildImage, /\$administratorPassword \| Export-Clixml/);
  });

  it("keeps only the guest credential, machine-scope DPAPI-protected and ACLed", () => {
    assert.match(buildImage, /\$credPath = Join-Path \$imageDir "\$ImageName\.cred\.json"/);
    assert.match(buildImage, /DataProtectionScope\]::LocalMachine/);
    assert.match(buildImage, /passwordProtected = \[Convert\]::ToBase64String/);
    // By SID, not by name: group names are localized, and the agent that has
    // to read this file back runs as LocalSystem (S-1-5-18).
    assert.match(
      buildImage,
      /icacls \$credPath \/inheritance:r \/grant:r '\*S-1-5-18:F' '\*S-1-5-32-544:F'/,
    );
    assert.match(buildImage, /if \(\$LASTEXITCODE -ne 0\) \{ throw "icacls failed to lock down/);
    // The piped form is the actual user-scope write; prose may still explain
    // why it is gone.
    assert.doesNotMatch(buildImage, /\| Export-Clixml/);
  });
});

describe("build-image.ps1 operator input", () => {
  it("XML-escapes every operator value that reaches the unattend file", () => {
    assert.match(buildImage, /function ConvertTo-XmlText/);
    assert.match(buildImage, /\$userXml = ConvertTo-XmlText \$GuestUser/);
    assert.match(buildImage, /\$passwordXml = ConvertTo-XmlText \$plain/);
    assert.match(buildImage, /\$administratorXml = ConvertTo-XmlText \$administratorPassword/);
  });

  it("interpolates only escaped values into the unattend XML", () => {
    const start = buildImage.indexOf("<?xml version=");
    const end = buildImage.indexOf("</unattend>");
    assert.ok(start > 0 && end > start);
    const unattend = buildImage.slice(start, end);
    const interpolated = [...unattend.matchAll(/\$(\w+)/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(interpolated)].toSorted(), [
      "administratorXml",
      "passwordXml",
      "userXml",
    ]);
  });

  it("validates the names that become file paths and account names", () => {
    assert.match(buildImage, /\$ImageName -notmatch '\^\[A-Za-z0-9\]/);
    assert.match(buildImage, /\$GuestUser -notmatch '\^\[A-Za-z0-9\]/);
  });
});

describe("build-image.ps1 Windows PowerShell 5.1 compatibility", () => {
  // Regression: RandomNumberGenerator::Fill is .NET Core / .NET 5+ only, and
  // New-RandomPassword is called unconditionally for the Administrator
  // throwaway, so the builder threw on every stock Windows host, which runs
  // Windows PowerShell 5.1 on the .NET Framework.
  it("draws random bytes through an API that exists on the .NET Framework", () => {
    assert.doesNotMatch(buildImage, /RandomNumberGenerator\]::Fill/);
    assert.match(buildImage, /RNGCryptoServiceProvider\]::new\(\)/);
  });

  it("disposes the RNG even when GetBytes throws", () => {
    assert.match(
      buildImage,
      /try \{ \$rng\.GetBytes\(\$bytes\) \} finally \{ \$rng\.Dispose\(\) \}/,
    );
  });

  // The guest runs the inbox shell -- Windows PowerShell 5.1 on the .NET
  // Framework -- and installs nothing that could provide a newer one.
  it("uses no PowerShell 7 syntax and expects no pwsh", () => {
    assert.doesNotMatch(buildImage, /\?\?/);
    assert.doesNotMatch(buildImage, /\$\w+\?\./);
    assert.doesNotMatch(buildImage, /\bpwsh\b/);
  });
});

describe("build-image.ps1 bless guard", () => {
  // Regression: the host read the finished disk back with Get-DiskImage, which
  // does not resolve a VHDX that Hyper-V itself has mounted, and blessed the
  // image on the completion marker alone.
  it("resolves the mounted VHDX through Hyper-V, not Get-DiskImage", () => {
    // Mount-/Dismount-DiskImage stay: those attach the installation ISO, which
    // is a plain disk image. Only the VHDX read-back had to change.
    assert.doesNotMatch(buildImage, /Get-DiskImage -ImagePath \$vhdxPath/);
    assert.match(buildImage, /\$osDrive = \(Get-VHD -Path \$vhdxPath \| Get-Disk/);
  });

  it("refuses to bless when the OS volume cannot be resolved", () => {
    assert.match(buildImage, /if \(-not \$osDrive\) \{ throw /);
  });

  it("requires the runner itself, not just the completion marker", () => {
    assert.match(buildImage, /\$ok = \(Test-Path "\$\{osDrive\}:\\rc-provision-complete"\) -and/);
    assert.match(buildImage, /\(Test-Path "\$\{osDrive\}:\\actions-runner\\run\.cmd"\)/);
  });

  it("fails inside the guest when the runner archive lacks run.cmd", () => {
    const expand = buildImage.indexOf("Expand-Archive");
    const guard = buildImage.indexOf("the runner archive did not contain run.cmd");
    assert.ok(guard > expand, "the run.cmd guard does not follow the archive expansion");
  });
});

describe("build-image.ps1 Defender", () => {
  // Regression: every image was built with real-time monitoring switched off,
  // permanently and silently.
  it("leaves real-time monitoring on unless the operator opts out", () => {
    assert.match(buildImage, /\[switch\] \$DisableDefenderRealtime/);
    const guard = buildImage.indexOf("if ($RcDisableDefenderRealtime) {");
    const disable = buildImage.indexOf("Set-MpPreference -DisableRealtimeMonitoring");
    assert.ok(guard > 0 && disable > guard, "Defender is disabled outside the opt-in guard");
    assert.equal(buildImage.split("Set-MpPreference").length - 1, 1);
  });

  it("records the choice in the image manifest", () => {
    assert.match(buildImage, /defenderRealtimeDisabled = \[bool\] \$DisableDefenderRealtime/);
  });
});

describe("agent invocation of the Windows provisioner", () => {
  // The JIT configuration reaches every provisioner on stdin, so it is in
  // neither argv nor the child's environment block, on any platform.
  it("hands the provisioner its input on stdin, never argv or the environment", () => {
    assert.match(agentSource, /input: jitConfig/);
    assert.doesNotMatch(agentSource, /\bJIT_CONFIG\b/);
    const afterExe = agentSource.slice(agentSource.indexOf('"powershell.exe"'));
    const argv = afterExe.slice(afterExe.indexOf("["), afterExe.indexOf("]") + 1);
    assert.match(argv, /"-File", script/);
    assert.doesNotMatch(argv, /jitConfig|JIT_CONFIG/);
  });

  it("runs the script non-interactively and past a Restricted policy", () => {
    assert.match(agentSource, /"-NonInteractive"/);
    assert.match(agentSource, /"-ExecutionPolicy", "Bypass"/);
  });
});

describe("Hyper-V readiness probe", () => {
  const probe = (() => {
    const start = readinessSource.indexOf("const HYPERV_PROBE = `");
    const end = readinessSource.indexOf("\n`;", start);
    if (start < 0 || end < start) throw new Error("readiness.ts has no HYPERV_PROBE");
    return readinessSource.slice(start, end);
  })();

  // The image name becomes a path under %RC_HOME%\images. It is validated
  // against the same pattern provision-win.ps1's Assert-SafeName uses, and it
  // travels through the environment so it never reaches a command line.
  it("hands the probe its image name through the environment, never argv", () => {
    assert.match(readinessSource, /RC_PROBE_IMAGE: profile\.imageRelease/);
    assert.match(probe, /\$image = \$env:RC_PROBE_IMAGE/);
    assert.match(readinessSource, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,62\}\$/);
    assert.match(provisionWin, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\{0,62\}\$/);
  });

  // The probe proves what provision-win.ps1 dies on: the module, the switch,
  // the parent VHDX and a credential this account can actually use.
  it("proves each prerequisite the provisioner would otherwise fail on", () => {
    for (const check of ["hyperv-module", "vm-switch", "parent-image", "guest-credential"]) {
      assert.match(probe, new RegExp(`name = '${check}'`), `${check} is not probed`);
    }
    assert.match(probe, /Get-VMSwitch -Name \$switchName/);
    assert.match(probe, /\$image \+ '\.vhdx'/);
    assert.match(probe, /\$image \+ '\.cred\.json'/);
  });

  // Same dual-read as the provisioner, and honest about the legacy file: it
  // exists for every account and decrypts for one, so the probe decrypts it as
  // the account the provisioner will run as rather than trusting Test-Path.
  it("prefers the machine-scope credential and decrypts the legacy one to prove it", () => {
    const json = probe.indexOf("Test-Path -LiteralPath $cred)");
    const xml = probe.indexOf("Test-Path -LiteralPath $credXml)");
    const decrypt = probe.indexOf("Import-Clixml -LiteralPath $credXml -ErrorAction Stop");
    assert.ok(json > 0 && xml > json, "the legacy credential is consulted first");
    assert.ok(decrypt > xml, "the legacy credential is trusted on existence alone");
    assert.match(probe, /\$legacyOk = \$null -ne \$legacy/);
    assert.match(probe, /passed = \$legacyOk/);
  });

  it("never lets a non-Windows host look ready for Hyper-V", () => {
    assert.match(readinessSource, /process\.platform !== "win32"/);
    assert.match(readinessSource, /this Worker is not a Windows host/);
  });
});

describe("Windows provisioner honesty", () => {
  it("marks both scripts as unverified on a real Windows host", () => {
    for (const [name, source] of [
      ["provision-win.ps1", provisionWin],
      ["build-image.ps1", buildImage],
    ] as const) {
      assert.match(source, /NOT VERIFIED ON A WINDOWS HOST/, `${name} drops the preview warning`);
    }
  });
});
