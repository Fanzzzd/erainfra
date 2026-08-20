import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readPinnedGoToolchain } from "../src/go-toolchain.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const runtimeOut = path.join(repoRoot, "apps", "runtime", "dist", "release");

/**
 * `--out <directory>` builds the same targets somewhere else, which is how the release workflow
 * builds twice and `cmp`s the two sets. Mirrors package-agent's flag.
 */
function parseOutDirectory(argv: readonly string[]) {
  const index = argv.indexOf("--out");
  if (index === -1) {
    return path.join(repoRoot, "dist", "release");
  }
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error("--out requires a directory");
  }
  return path.resolve(repoRoot, value);
}

const releaseOut = parseOutDirectory(process.argv.slice(2));

type Target = {
  // The Infra Agent runs on a Node, and a Node is any box a customer owns — including the Windows
  // ones deploy/infra/agent.ps1 already onboards.
  os: "linux" | "darwin" | "windows";
  arch: "amd64" | "arm64";
  output: string;
  package: string;
  embed?: string;
  ldflags: string;
};

/** Release assets are named by the CPU the operator sees, not by Go's GOARCH spelling. */
function assetName(name: string, os: Target["os"], arch: Target["arch"]) {
  return `${name}-${os}-${arch === "amd64" ? "x86_64" : arch}${os === "windows" ? ".exe" : ""}`;
}

const version = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version as
  | string
  | undefined;
if (version === undefined || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/.test(version)) {
  throw new Error("package.json has no valid product version");
}
const commit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
}).trim();

const targets: Target[] = [
  {
    os: "linux",
    arch: "amd64",
    output: path.join(releaseOut, "runner-center-runtime-linux-x86_64"),
    package: "./apps/runtime/cmd/runner-center-runtime",
    embed: path.join(runtimeOut, "linux-x86_64", "runner-center-runtime"),
    ldflags: `-s -w -buildid= -X main.version=${version}`,
  },
  {
    os: "linux",
    arch: "arm64",
    output: path.join(releaseOut, "runner-center-runtime-linux-arm64"),
    package: "./apps/runtime/cmd/runner-center-runtime",
    embed: path.join(runtimeOut, "linux-arm64", "runner-center-runtime"),
    ldflags: `-s -w -buildid= -X main.version=${version}`,
  },
  ...(["linux", "darwin"] as const).flatMap((os) =>
    (["amd64", "arm64"] as const).map((arch) => ({
      os,
      arch,
      output: path.join(releaseOut, assetName("runner-center-controller", os, arch)),
      package: "./apps/controller/cmd/runner-center-controller",
      ldflags: `-s -w -buildid= -X main.version=${version} -X main.commitSHA=${commit}`,
    })),
  ),
  // The Infra Agent. Building it here rather than ad hoc on a customer's hub box is what lets its
  // checksum be pinned before a Node ever downloads it (ADR 0006): these flags produce
  // byte-identical output across builds, so the release workflow can build twice and cmp.
  ...(
    [
      { os: "linux", arch: "amd64" },
      { os: "linux", arch: "arm64" },
      { os: "darwin", arch: "amd64" },
      { os: "darwin", arch: "arm64" },
      { os: "windows", arch: "amd64" },
    ] as const
  ).map(({ os, arch }) => ({
    os,
    arch,
    output: path.join(releaseOut, assetName("infra-agent", os, arch)),
    package: "./apps/infra-agent",
    ldflags: `-s -w -buildid= -X main.version=${version}`,
  })),
];

// These assets are what a Node's installer verifies against, and deploy/infra/build-agents.sh
// recompiles the same bytes on a customer's hub. Both read the toolchain from go.mod's go directive
// and both set GOTOOLCHAIN explicitly, because the default resolves to "at least" rather than
// "exactly" and a patch difference changes the bytes.
const toolchain = readPinnedGoToolchain(repoRoot);
const buildEnv = { ...process.env, CGO_ENABLED: "0", GOTOOLCHAIN: toolchain.goToolchain };

// Setting it is not the same as getting it: a box that cannot obtain the pinned toolchain must fail
// here, naming the toolchain, rather than publish bytes nobody can reproduce. Both failure shapes
// end up in the same message — go reporting a different version, and go refusing to run at all,
// which is what an offline box does when GOTOOLCHAIN names a toolchain it cannot download.
let reported: string;
try {
  reported = execFileSync("go", ["version"], { cwd: repoRoot, encoding: "utf8", env: buildEnv })
    .trim()
    .split(" ")[2];
} catch {
  reported = "nothing";
}
if (reported !== toolchain.expectedGoVersion) {
  throw new Error(
    `go.mod pins ${toolchain.expectedGoVersion} but this build would use ${reported}. These assets are only byte-reproducible on the pinned toolchain — a Go patch release is enough to change the bytes a Node then verifies — so the build stops here rather than publishing something the hub cannot reproduce. An offline box cannot download ${toolchain.expectedGoVersion}; install it, or build where it is available.`,
  );
}
console.log(`building Go assets with ${toolchain.expectedGoVersion} (pinned by go.mod)`);

rmSync(runtimeOut, { recursive: true, force: true });
rmSync(releaseOut, { recursive: true, force: true });
mkdirSync(runtimeOut, { recursive: true });
mkdirSync(releaseOut, { recursive: true });

for (const target of targets) {
  mkdirSync(path.dirname(target.output), { recursive: true });
  execFileSync(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      `-ldflags=${target.ldflags}`,
      "-o",
      target.output,
      target.package,
    ],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: { ...buildEnv, GOOS: target.os, GOARCH: target.arch },
    },
  );
  const digest = createHash("sha256").update(readFileSync(target.output)).digest("hex");
  writeFileSync(`${target.output}.sha256`, `${digest}  ${path.basename(target.output)}\n`);
  if (target.embed !== undefined) {
    mkdirSync(path.dirname(target.embed), { recursive: true });
    copyFileSync(target.output, target.embed);
  }
}
