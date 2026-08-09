import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { createTar, createTarGz, gzip, type TarEntry } from "../src/tar.ts";

const workspaces: string[] = [];

function workspace() {
  const directory = mkdtempSync(path.join(tmpdir(), "rc-tar-"));
  workspaces.push(directory);
  return directory;
}

after(() => {
  for (const directory of workspaces) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const entries: TarEntry[] = [
  { path: "agent/", mode: 0o755, data: new Uint8Array() },
  { path: "agent/package.json", mode: 0o644, data: Buffer.from('{"name":"agent"}\n') },
  { path: "agent/provisioners/", mode: 0o755, data: new Uint8Array() },
  { path: "agent/provisioners/run.sh", mode: 0o755, data: Buffer.from("#!/bin/sh\nexit 0\n") },
];

describe("createTarGz", () => {
  it("produces the same bytes every time", () => {
    assert.deepEqual(createTarGz(entries), createTarGz(entries));
  });

  it("extracts with system tar, preserving contents and modes", () => {
    const directory = workspace();
    const archivePath = path.join(directory, "agent.tar.gz");
    writeFileSync(archivePath, createTarGz(entries));
    execFileSync("tar", ["-xzf", archivePath, "-C", directory, "--strip-components=1"]);

    assert.equal(readFileSync(path.join(directory, "package.json"), "utf8"), '{"name":"agent"}\n');
    const script = path.join(directory, "provisioners", "run.sh");
    assert.equal(readFileSync(script, "utf8"), "#!/bin/sh\nexit 0\n");
    assert.equal(statSync(script).mode & 0o777, 0o755);
    assert.equal(statSync(path.join(directory, "package.json")).mode & 0o777, 0o644);
  });

  it("normalizes timestamps and ownership so nothing leaks from the build host", () => {
    const header = createTar(entries).subarray(0, 512);
    const field = (offset: number, size: number) => {
      const raw = header.subarray(offset, offset + size);
      const terminator = raw.indexOf(0);
      return raw.subarray(0, terminator === -1 ? raw.length : terminator).toString("utf8");
    };

    assert.equal(field(108, 8), "0000000", "uid");
    assert.equal(field(116, 8), "0000000", "gid");
    assert.equal(field(136, 12), "00000000000", "mtime");
    assert.equal(field(265, 32), "", "owner name");
    assert.equal(field(297, 32), "", "group name");
    assert.equal(field(257, 6), "ustar", "format");
  });

  it("rejects a path that does not fit in a ustar header", () => {
    const tooLong = { path: `agent/${"a".repeat(120)}`, mode: 0o644, data: new Uint8Array() };
    assert.throws(() => createTar([tooLong]), /exceeds 100 bytes/);
  });

  it("rejects a directory entry that carries data", () => {
    const bad = { path: "agent/dist/", mode: 0o755, data: Buffer.from("x") };
    assert.throws(() => createTar([bad]), /must not carry data/);
  });
});

describe("gzip", () => {
  it("has one exact representation independent of the host zlib", () => {
    const compressed = gzip(Buffer.from("hello"));
    assert.equal(
      compressed.toString("hex"),
      "1f8b08000000000000ff010500faff68656c6c6f86a6103605000000",
    );
  });

  it("splits payloads larger than one stored block and remains gzip-compatible", () => {
    const original = Buffer.alloc(70_000, 0xa5);
    assert.deepEqual(gunzipSync(gzip(original)), original);
  });
});
