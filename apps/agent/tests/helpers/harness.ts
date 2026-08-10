import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVISIONERS = fileURLToPath(new URL("../../provisioners/", import.meta.url));
export const PROVISION_MAC = join(PROVISIONERS, "provision-mac.sh");
export const PROVISION_LINUX = join(PROVISIONERS, "provision-linux.sh");
export const PROVISION_DOCKER = join(PROVISIONERS, "provision-docker.sh");
export const PROVISION_WIN = join(PROVISIONERS, "provision-win.ps1");

/** A JIT configuration that is valid base64 and unmistakable in any output. */
export const FAKE_JIT = Buffer.from(
  JSON.stringify({ marker: "RC-FAKE-JIT-SENTINEL-DO-NOT-LEAK" }),
).toString("base64");

export const FAKE_HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeFakeFakeFakeFakeFakeFakeFakeFakeFakeFa";

export type RunResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type RunningScript = {
  kill: (signal: NodeJS.Signals) => void;
  output: () => string;
  done: Promise<RunResult>;
};

function sha256(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * A sandbox that stands in for a real Apple Silicon host: fake `tart`,
 * `sshpass`, `curl`, `docker`, `uname` and `df`, plus a real SHA-256
 * implementation so checksum handling is genuinely exercised rather than
 * stubbed away.
 *
 * Every fake appends its argv to `argvLog` -- that log is what the
 * secret-exposure assertions read -- and every fake that consumes stdin dumps
 * it into `stdinDir`.
 */
export class Harness {
  readonly root: string;
  readonly bin: string;
  readonly home: string;
  readonly stdinDir: string;
  readonly argvLog: string;
  readonly tarballContent: string;
  readonly tarballSha256: string;

  constructor(options: { tarballContent?: string } = {}) {
    this.root = mkdtempSync(join(tmpdir(), "rc-harness-"));
    this.bin = join(this.root, "bin");
    this.home = join(this.root, "home");
    this.stdinDir = join(this.root, "stdin");
    this.argvLog = join(this.root, "argv.log");
    this.tarballContent = options.tarballContent ?? "pretend-this-is-a-runner-tarball\n";
    this.tarballSha256 = sha256(this.tarballContent);

    mkdirSync(this.bin, { recursive: true });
    mkdirSync(this.home, { recursive: true });
    mkdirSync(this.stdinDir, { recursive: true });
    writeFileSync(this.argvLog, "");
    writeFileSync(join(this.root, "tarball-content"), this.tarballContent);

    this.#writeFakes();
  }

  #write(name: string, body: string) {
    const path = join(this.bin, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }

  #writeFakes() {
    // Built up in one string and written with a single printf, so concurrent
    // fakes (the backgrounded `tart run` and everything else) cannot interleave
    // half-lines into the log.
    const logArgv = `rc_line="\${0##*/}"; for a in "$@"; do rc_line="$rc_line	$a"; done; printf '%s\\n' "$rc_line" >> "$RC_ARGV_LOG"`;

    this.#write(
      "tart",
      `#!/bin/sh
${logArgv}
case "$1" in
  list)
    case " $* " in
      *" --quiet "*) printf '%s' "\${RC_FAKE_TART_NAMES:-}" ;;
      *) printf '%s\\n' "\${RC_FAKE_TART_LIST:-[]}" ;;
    esac
    ;;
  clone) exit "\${RC_FAKE_TART_CLONE_EXIT:-0}" ;;
  run) while :; do sleep 1; done ;;
  ip)
    [ -n "\${RC_FAKE_TART_NO_IP:-}" ] && exit 1
    printf '%s\\n' "192.0.2.10"
    ;;
  exec)
    [ -n "\${RC_FAKE_TART_NO_GUEST_AGENT:-}" ] && exit 1
    printf '%s\\n' "$RC_FAKE_HOST_KEY"
    ;;
  stop | delete) exit 0 ;;
  *) exit 1 ;;
esac
`,
    );

    // Stands in for `sshpass -f <file> ssh <options...> user@host <command>`.
    // Which guest script is running is inferred from stdin, because that is
    // where this provisioner puts everything that matters.
    this.#write(
      "sshpass",
      `#!/bin/sh
${logArgv}
capture="$RC_STDIN_DIR/ssh-$(ls "$RC_STDIN_DIR" | wc -l | tr -d ' ')"
cat > "$capture"
payload="$(cat "$capture")"

case "$payload" in
  *"uname -m"*)
    printf 'arm64 /usr/bin/tar /usr/bin/shasum 120\\n'
    exit 0
    ;;
  *ACTIONS_RUNNER_INPUT_JITCONFIG*)
    # The sleep gets its own descriptors so that killing this fake releases the
    # inherited stdout immediately, the way killing a real ssh client would.
    sleep "\${RC_FAKE_RUNNER_SLEEP:-0}" >/dev/null 2>&1
    exit "\${RC_FAKE_RUNNER_EXIT:-0}"
    ;;
  *"tar -xzf"*)
    exit "\${RC_FAKE_INSTALL_EXIT:-0}"
    ;;
esac

exit "\${RC_FAKE_SSH_EXIT:-0}"
`,
    );

    this.#write(
      "curl",
      `#!/bin/sh
${logArgv}
out=""
prev=""
fail_flag=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  case "$a" in --fail | -f* ) fail_flag=1 ;; esac
  prev="$a"
done

# The real ghcr.io/v2/ answers 401 to an anonymous request, which curl --fail
# turns into a non-zero exit even though the registry is plainly reachable.
case "$*" in
  *"https://ghcr.io/v2/"*)
    [ -n "\${RC_FAKE_CURL_FAIL:-}" ] && exit 7
    [ -n "$fail_flag" ] && exit 22
    exit 0
    ;;
esac

[ -n "\${RC_FAKE_CURL_FAIL:-}" ] && exit 22

if [ -n "$out" ] && [ "$out" != "/dev/null" ]; then
  cat "$RC_FAKE_TARBALL_CONTENT" > "$out"
fi
exit 0
`,
    );

    this.#write("uname", `#!/bin/sh\nprintf '%s\\n' "\${RC_FAKE_UNAME_M:-arm64}"\n`);

    // BSD-style `df -g` output so the free-space branch behaves identically on
    // macOS and on the Linux CI runner.
    this.#write(
      "df",
      `#!/bin/sh
printf 'Filesystem 1G-blocks Used Avail Capacity Mounted\\n'
printf 'fake 926 100 %s 20 /\\n' "\${RC_FAKE_DF_AVAIL:-500}"
`,
    );

    this.#write(
      "shasum",
      `#!/bin/sh
exec node -e 'const c=require("crypto"),f=require("fs");const p=process.argv[1];process.stdout.write(c.createHash("sha256").update(f.readFileSync(p)).digest("hex")+"  "+p+"\\n")' "$3"
`,
    );

    this.#write("ssh", "#!/bin/sh\nexit 0\n");
    this.#write(
      "docker",
      `#!/bin/sh
${logArgv}
case "$1" in
  run)
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--env-file" ]; then
        cat "$a" > "$RC_STDIN_DIR/docker-env"
        break
      fi
      prev="$a"
    done
    # Stand in for a running container: exit as soon as \`docker stop\`/\`rm\`
    # marks it stopped, the way a real client would.
    i=0
    while [ "$i" -lt "\${RC_FAKE_DOCKER_SLEEP:-0}" ]; do
      [ -f "$RC_FAKE_DOCKER_STOPPED" ] && exit 137
      sleep 1 >/dev/null 2>&1
      i=$((i + 1))
    done
    ;;
  stop | rm)
    : > "$RC_FAKE_DOCKER_STOPPED"
    exit 0
    ;;
esac
exit "\${RC_FAKE_DOCKER_EXIT:-0}"
`,
    );
  }

  env(overrides: Record<string, string> = {}) {
    return {
      PATH: `${this.bin}:${process.env.PATH ?? ""}`,
      HOME: this.home,
      TMPDIR: this.root,
      RC_HOME: join(this.home, ".runner-center"),
      RC_ARGV_LOG: this.argvLog,
      RC_STDIN_DIR: this.stdinDir,
      RC_FAKE_HOST_KEY: FAKE_HOST_KEY,
      RC_FAKE_TARBALL_CONTENT: join(this.root, "tarball-content"),
      RC_FAKE_DOCKER_STOPPED: join(this.root, "docker-stopped"),
      TART: join(this.bin, "tart"),
      SSHPASS: join(this.bin, "sshpass"),
      RUNNER_NAME: "rc-test-runner",
      RC_MAC_RUNNER_SHA256: this.tarballSha256,
      RC_BOOT_TIMEOUT_S: "15",
      RC_JOB_TIMEOUT_S: "0",
      ...overrides,
    };
  }

  start(
    script: string,
    options: { env?: Record<string, string>; stdin?: string } = {},
  ): RunningScript {
    const child = spawn("bash", [script], {
      env: this.env(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? FAKE_JIT);

    const done = new Promise<RunResult>((resolve) => {
      child.on("close", (code, signal) => {
        resolve({ code: code ?? -1, signal, stdout, stderr });
      });
    });

    return {
      kill: (signal) => child.kill(signal),
      output: () => stdout + stderr,
      done,
    };
  }

  async run(script: string, options: { env?: Record<string, string>; stdin?: string } = {}) {
    const running = this.start(script, options);
    const timer = setTimeout(() => running.kill("SIGKILL"), 60_000);
    try {
      return await running.done;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every argument every fake binary was invoked with, one line per call. */
  argv() {
    return readFileSync(this.argvLog, "utf8");
  }

  /** Everything the fakes read from stdin, concatenated. */
  stdinCaptures() {
    return readdirSync(this.stdinDir)
      .map((name) => readFileSync(join(this.stdinDir, name), "utf8"))
      .join("\n---\n");
  }
}

/** Resolves once `predicate` sees the text it wants, or rejects on timeout. */
export async function waitFor(predicate: () => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for the provisioner to reach the expected state");
}
