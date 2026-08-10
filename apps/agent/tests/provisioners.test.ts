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

// The runner archive pin, shared by the checksum and drift tests below.
const PINNED_RUNNER_VERSION = "2.336.0";
const PINNED_RUNNER_SHA256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162";

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
    assert.match(provisionDocker, /--pids-limit 4096/);
    assert.match(provisionDocker, /--user runner/);
  });

  it("passes JIT through a FIFO, never argv, host env, or a regular file", () => {
    assert.match(provisionDocker, /mkfifo "\$WORKDIR\/runner\.env"/);
    assert.match(provisionDocker, /--env-file "\$WORKDIR\/runner\.env"/);
    assert.doesNotMatch(provisionDocker, /export ACTIONS_RUNNER_INPUT_JITCONFIG/);
    assert.doesNotMatch(provisionDocker, /--env ACTIONS_RUNNER_INPUT_JITCONFIG/);
  });

  it("never exposes the Docker socket or a host bind mount", () => {
    assert.doesNotMatch(provisionDocker, /docker\.sock|--privileged|--volume|-v \/|type=bind/);
    assert.match(provisionDocker, /type=volume,src=\$CACHE_VOLUME,dst=\/runner-cache\/pnpm/);
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
    assert.match(provisionWin, /& \$runner 2>&1 \| ForEach-Object \{ Write-Host \$_ \}/);
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
    assert.doesNotMatch(provisionWin, /ProtectedData/);
    assert.doesNotMatch(provisionWin, /WriteAllBytes/);
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

  it("keeps only the guest credential, DPAPI-protected", () => {
    assert.match(
      buildImage,
      /\[pscredential\]::new\(\$GuestUser, \$GuestPassword\) \| Export-Clixml/,
    );
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
