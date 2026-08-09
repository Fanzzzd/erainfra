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
const agentSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

// The runner archive pin, shared by the checksum and drift tests below.
const PINNED_RUNNER_VERSION = "2.336.0";
const PINNED_RUNNER_SHA256 = "d59123a43003e357b0805b5d0f611d0bd2f65ab67d51bd070dd4e7a0f685c162";

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
  // read it back. It is now materialised as the runner's own config files.
  it("never puts the JIT configuration on a command line", () => {
    assert.doesNotMatch(provisionWin, /--jitconfig/);
  });

  it("passes the JIT configuration over the remoting socket instead", () => {
    assert.match(provisionWin, /-ArgumentList \$jitConfig, \$RunnerRoot/);
  });

  it("never writes the JIT configuration or a password to output", () => {
    for (const line of provisionWin.split("\n")) {
      if (!/Write-(Host|Output|Error|Warning)/.test(line)) continue;
      assert.doesNotMatch(line, /\$jitConfig|\$Jit\b|\$password|\$credential/, line.trim());
    }
  });

  it("refuses runner config file names that could escape the runner root", () => {
    assert.match(provisionWin, /\$name -notmatch '\^\\\.\[A-Za-z0-9_\]\{1,64\}\$'/);
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
    assert.match(provisionWin, /Get-PositiveIntEnv 'BOOT_TIMEOUT_S' \d+/);
    assert.match(provisionWin, /Get-PositiveIntEnv 'JOB_TIMEOUT_S' \d+/);
    assert.match(provisionWin, /Timed out after \$\{jobTimeout\}s/);
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
  it("hands the provisioner its input through the environment, never argv", () => {
    assert.match(agentSource, /JIT_CONFIG: jitConfig/);
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
