/**
 * Exercises the generated install script end to end in a sandbox.
 *
 * `HOME` points at a temporary directory and `PATH` starts with stubs for
 * `curl`, `npm`, and the service manager, so a test never reaches the network,
 * never installs a launchd or systemd service, and never touches the real
 * `~/.runner-center`.
 */
import assert from "node:assert/strict";
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
import { after, describe, it } from "node:test";
import { AGENT_RELEASE, type AgentRelease } from "../convex/agentRelease.ts";
import { renderInstallScript } from "../convex/installScript.ts";

const SITE_URL = "https://example.convex.site";
const TEST_REPO = "runner-center-tests/runner-center";
const MACHINE_TOKEN = "a".repeat(32);
const CONNECTED_LINE = "Runner Center agent connected to https://example.convex.cloud";
const SERVICE_KIND = process.platform === "darwin" ? "launchd" : "systemd";

const sandboxes: string[] = [];

after(() => {
  for (const directory of sandboxes) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeExecutable(filePath: string, contents: string) {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
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

/** Both service managers "start" the agent by writing the line the installer waits for. */
const SERVICE_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$RC_TEST_SERVICE_LOG"
for arg in "$@"; do
  case "$arg" in
    kickstart|restart)
      if [ "$RC_TEST_CONNECT" = "1" ]; then
        printf '${CONNECTED_LINE}\\n' >> "$HOME/.runner-center/agent.log"
      fi
      ;;
  esac
done
exit 0
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
  assert.notEqual(home, homedir(), "the sandbox must not be the real home directory");

  writeExecutable(
    path.join(binDir, "node"),
    `#!/usr/bin/env bash\nexec ${process.execPath} "$@"\n`,
  );
  writeExecutable(path.join(binDir, "npm"), NPM_STUB);
  writeExecutable(path.join(binDir, "curl"), CURL_STUB);
  writeExecutable(path.join(binDir, "launchctl"), SERVICE_STUB);
  writeExecutable(path.join(binDir, "systemctl"), SERVICE_STUB);

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
  };
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
function publishRelease(sandbox: Sandbox, release: AgentRelease, marker: string) {
  const stage = path.join(sandbox.fixtures, `stage-${release.version}`, "agent");
  mkdirSync(path.join(stage, "dist"), { recursive: true });
  mkdirSync(path.join(stage, "provisioners"), { recursive: true });
  writeFileSync(path.join(stage, "dist", "index.js"), `// ${marker}\n`);
  writeFileSync(path.join(stage, "package.json"), `{"version":"${release.version}"}\n`);
  writeFileSync(path.join(stage, "package-lock.json"), '{"lockfileVersion":3}\n');
  writeFileSync(path.join(stage, "provisioners", "provision-linux.sh"), "#!/usr/bin/env bash\n");

  const assetName = `runner-center-agent-${release.version}.tar.gz`;
  const archivePath = path.join(sandbox.fixtures, assetName);
  const tar = spawnSync("tar", ["-czf", archivePath, "-C", path.dirname(stage), "agent"]);
  assert.equal(tar.status, 0, tar.stderr?.toString());

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
  return spawnSync("bash", [sandbox.scriptPath, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${path.join(sandbox.root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: sandbox.home,
      RC_TEST_ROUTES: sandbox.routesPath,
      RC_TEST_CURL_LOG: sandbox.curlLog,
      RC_TEST_NPM_LOG: sandbox.npmLog,
      RC_TEST_SERVICE_LOG: path.join(sandbox.root, "service.log"),
      RC_TEST_NPM_FAIL: options.npmFails === true ? "1" : "0",
      RC_TEST_CONNECT: options.connect === false ? "0" : "1",
    },
  });
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

const CURRENT: AgentRelease = { repo: TEST_REPO, version: "1.4.2", sha256: "" };
const OLDER: AgentRelease = { repo: TEST_REPO, version: "1.3.0", sha256: "" };

describe("install", () => {
  it("installs the immutable release asset this deployment pins", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    repin(sandbox, { ...CURRENT, sha256: published.sha256 });
    publishRegistration(sandbox);

    const result = run(sandbox, ["--token", "rcreg_test", "--name", "test-machine"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const requested = readLog(sandbox.curlLog);
    assert.match(
      requested,
      /https:\/\/github\.com\/runner-center-tests\/runner-center\/releases\/download\/v1\.4\.2\/runner-center-agent-1\.4\.2\.tar\.gz$/m,
    );
    assert.doesNotMatch(requested, /archive\/refs\/heads/);
    assert.equal(agentMarker(sandbox), "// new agent");
    assert.equal(metaField(sandbox, "AGENT_VERSION"), "1.4.2");
    assert.match(
      readFileSync(path.join(sandbox.rcHome, "agent", ".env"), "utf8"),
      new RegExp(`MACHINE_TOKEN=${MACHINE_TOKEN}`),
    );
  });

  it("installs dependencies from the release lockfile with npm ci", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    publishRegistration(sandbox);

    assert.equal(run(sandbox, ["--token", "rcreg_test"]).status, 0);
    assert.match(readLog(sandbox.npmLog), /^ci --omit=dev --no-audit --no-fund$/m);
    assert.ok(existsSync(path.join(sandbox.rcHome, "agent", "node_modules", ".installed")));
  });
});

describe("update", () => {
  it("installs the version the operator pins, so a rollback is one command", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    publishRelease(sandbox, OLDER, "older agent");
    seedExistingInstall(sandbox, "1.4.2", "current agent");

    const result = run(sandbox, ["--update", "--version", "v1.3.0"]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

    const requested = readLog(sandbox.curlLog);
    assert.match(requested, /releases\/download\/v1\.3\.0\/runner-center-agent-1\.3\.0\.tar\.gz$/m);
    assert.doesNotMatch(requested, /runner-center-agent-1\.4\.2/);
    assert.equal(agentMarker(sandbox), "// older agent");
    assert.equal(metaField(sandbox, "AGENT_VERSION"), "1.3.0");
  });

  it("keeps the replaced installation so a bad release can be recovered", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    assert.equal(run(sandbox, ["--update"]).status, 0);
    assert.equal(agentMarker(sandbox), "// new agent");
    assert.equal(agentMarker(sandbox, "agent.previous"), "// older agent");
  });

  it("carries the machine credentials across the replacement", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    assert.equal(run(sandbox, ["--update"]).status, 0);
    assert.match(
      readFileSync(path.join(sandbox.rcHome, "agent", ".env"), "utf8"),
      new RegExp(`MACHINE_TOKEN=${MACHINE_TOKEN}`),
    );
  });

  it("refuses an update when no machine is registered yet", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");

    const result = run(sandbox, ["--update"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No existing Runner Center registration/);
  });

  it("rejects a version that is not a release version", () => {
    const sandbox = createSandbox(CURRENT);
    const result = run(sandbox, ["--update", "--version", "main"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--version must be a release version/);
  });
});

describe("checksum verification", () => {
  it("stops before touching the running agent when the archive does not match", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "tampered agent");
    writeFileSync(published.checksumPath, `${"0".repeat(64)}  runner-center-agent-1.4.2.tar.gz\n`);
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum verification failed/);
    assert.equal(agentMarker(sandbox), "// older agent");
    assert.ok(!existsSync(path.join(sandbox.rcHome, "agent.previous")));
    assert.equal(readLog(sandbox.npmLog), "");
  });

  it("rejects an archive that the release vouches for but this deployment does not", () => {
    const sandbox = createSandbox({ ...CURRENT, sha256: "b".repeat(64) });
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pinned by this Runner Center deployment/);
    assert.equal(agentMarker(sandbox), "// older agent");
  });

  it("accepts an archive that matches the checksum passed on the command line", () => {
    const sandbox = createSandbox(CURRENT);
    const published = publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");
    rmSync(published.checksumPath);

    const result = run(sandbox, ["--update", "--sha256", published.sha256]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(agentMarker(sandbox), "// new agent");
  });
});

describe("rollback", () => {
  it("restores the previous agent when the new one never connects", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"], { connect: false });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rolled back to the previous installation/);
    assert.equal(agentMarker(sandbox), "// older agent");
    assert.ok(!existsSync(path.join(sandbox.rcHome, "agent.previous")));
    assert.equal(metaField(sandbox, "AGENT_VERSION"), "1.3.0");
  });

  it("leaves the running agent in place when dependency installation fails", () => {
    const sandbox = createSandbox(CURRENT);
    publishRelease(sandbox, CURRENT, "new agent");
    seedExistingInstall(sandbox, "1.3.0", "older agent");

    const result = run(sandbox, ["--update"], { npmFails: true });

    assert.notEqual(result.status, 0);
    assert.equal(agentMarker(sandbox), "// older agent");
    assert.ok(!existsSync(path.join(sandbox.rcHome, "agent.previous")));
  });
});

describe("rendered script", () => {
  const script = renderInstallScript(SITE_URL, AGENT_RELEASE);

  it("is valid bash", () => {
    const check = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);
  });

  it("never downloads a mutable branch tarball", () => {
    assert.doesNotMatch(script, /archive\/refs\/heads/);
    assert.match(script, /releases\/download\/v\$VERSION/);
  });

  it("carries the release this deployment pins", () => {
    assert.match(AGENT_RELEASE.version, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/);
    assert.match(AGENT_RELEASE.repo, /^[\w.-]+\/[\w.-]+$/);
    assert.ok(
      AGENT_RELEASE.sha256 === "" || /^[0-9a-f]{64}$/.test(AGENT_RELEASE.sha256),
      "sha256 must be empty or a 64-character lowercase digest",
    );
    assert.match(script, new RegExp(`PINNED_VERSION='${AGENT_RELEASE.version}'`));
  });
});
