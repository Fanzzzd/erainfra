import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const runtimeOut = path.join(repoRoot, "apps", "runtime", "dist", "release");
const releaseOut = path.join(repoRoot, "dist", "release");

type Target = {
  os: "linux" | "darwin";
  arch: "amd64" | "arm64";
  output: string;
  package: string;
  embed?: string;
  ldflags: string;
};

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
      output: path.join(
        releaseOut,
        `runner-center-controller-${os}-${arch === "amd64" ? "x86_64" : arch}`,
      ),
      package: "./apps/controller/cmd/runner-center-controller",
      ldflags: `-s -w -buildid= -X main.version=${version} -X main.commitSHA=${commit}`,
    })),
  ),
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
