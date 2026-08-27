import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

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
  // The cache service (ADR 0009). One Linux target, not the Infra Agent's five: it is a server an
  // operator deploys on infrastructure they control, not a binary that must run on every customer
  // box. Version-only ldflags, exactly like the Infra Agent above and unlike the controller: this
  // binary is pinned by digest in AGENT_RELEASE, so a commitSHA stamp would make its checksum a
  // function of the release commit — a value that cannot be written into the commit whose checksum
  // the release gate rebuilds and demands it match.
  {
    os: "linux",
    arch: "amd64",
    output: path.join(releaseOut, assetName("erainfra-cache-service", "linux", "amd64")),
    package: "./apps/cache-service/cmd/erainfra-cache-service",
    ldflags: `-s -w -buildid= -X main.version=${version}`,
  },
];

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
      env: { ...process.env, CGO_ENABLED: "0", GOOS: target.os, GOARCH: target.arch },
    },
  );
  const digest = createHash("sha256").update(readFileSync(target.output)).digest("hex");
  writeFileSync(`${target.output}.sha256`, `${digest}  ${path.basename(target.output)}\n`);
  if (target.embed !== undefined) {
    mkdirSync(path.dirname(target.embed), { recursive: true });
    copyFileSync(target.output, target.embed);
  }
}
