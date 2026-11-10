#!/usr/bin/env python3
"""Verify upstream order, reuse integration pins, and write a disjoint-layer OCI image."""
import concurrent.futures
import gzip
import hashlib
import json
import os
import pathlib
import re
import stat
import subprocess
import sys


def verify(upstream, recipe):
    template = pathlib.Path(upstream) / "images/ubuntu/templates/build.ubuntu-24_04.pkr.hcl"
    actual = re.findall(r'/scripts/build/([^"\s]+)', template.read_text())
    expected = pathlib.Path(recipe).read_text().splitlines()
    if actual != expected or len(actual) != len(set(actual)):
        raise ValueError("upstream Packer script order changed; review the recipe")
    print(f"Verified all {len(actual)} upstream build scripts in Packer order")


def overlay(dockerfile, output):
    text = pathlib.Path(dockerfile).read_text()
    version = re.search(r"^ARG RUNNER_VERSION=(\S+)$", text, re.M).group(1)
    blocks = re.findall(r"^RUN .*?(?=\n\n|\Z)", text, re.M | re.S)
    selected = [b for b in blocks if "runner_arch=x64" in b or "/opt/action-cache/actions_checkout" in b]
    if len(selected) != 2:
        raise ValueError("runner/action-cache Dockerfile blocks changed; review extraction")
    pathlib.Path(output).write_text(
        f"#!/bin/bash\nset -euo pipefail\nexport RUNNER_VERSION={version} TARGETARCH=amd64\n"
        + "\n".join(b.removeprefix("RUN ") for b in selected) + "\n"
    )


def environment(source, output):
    values = {}
    runtime = {"LANG", "HOME", "USER", "LOGNAME", "RUNNER_TOOL_CACHE", "AGENT_TOOLSDIRECTORY", "ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE"}
    for line in pathlib.Path(source).read_text().splitlines():
        if not line.strip() or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", key) or key in values:
            raise ValueError(f"invalid or duplicate environment key: {key}")
        if value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        if "$" in value or "`" in value or "\x00" in value:
            raise ValueError(f"unresolved environment expression: {key}")
        if key not in runtime:
            values[key] = value
    pathlib.Path(output).write_text(json.dumps(values, sort_keys=True, indent=2) + "\n")


# GHCR rejects layers over 10 GB and uploads over 10 minutes. Disjoint layers
# of about 4 GiB stay well inside both, and no file is stored twice.
LAYER_TARGET_BYTES = 4 * 1024**3
REGISTRY_LAYER_LIMIT_BYTES = 10 * 1000**3


def plan_layers(root, target=LAYER_TARGET_BYTES):
    """Return every directory, then groups of non-directory paths in path order.

    Directories go first so later layers never create parents implicitly.
    All hard links to one inode stay in the group of its first path, so tar
    stores the data once and writes the other paths as links.
    """
    root = pathlib.Path(root)
    device = root.lstat().st_dev
    directories, groups, current, size, inode_group = ["."], [], [], 0, {}
    for top, dirnames, filenames in os.walk(root):
        dirnames.sort()
        kept = []
        for name in dirnames:
            path = pathlib.Path(top, name)
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                filenames.append(name)
                continue
            # Like tar --one-file-system: keep a mount point, not its contents.
            directories.append("./" + path.relative_to(root).as_posix())
            if info.st_dev == device:
                kept.append(name)
        dirnames[:] = kept
        for name in sorted(filenames):
            path = pathlib.Path(top, name)
            info = path.lstat()
            relative = "./" + path.relative_to(root).as_posix()
            if stat.S_ISREG(info.st_mode) and info.st_nlink > 1:
                key = (info.st_dev, info.st_ino)
                if key in inode_group:
                    index = inode_group[key]
                    (groups[index] if index < len(groups) else current).append(relative)
                    continue
                inode_group[key] = len(groups)
            current.append(relative)
            size += info.st_size if stat.S_ISREG(info.st_mode) else 512
            if size >= target:
                groups.append(current)
                current, size = [], 0
    if current:
        groups.append(current)
    return directories, groups


def pack(root, destination, evidence, repo):
    dest = pathlib.Path(destination)
    blobs = dest / "blobs/sha256"
    blobs.mkdir(parents=True)
    directories, groups = plan_layers(root)

    def layer(index, paths):
        listing = dest / f"layer-{index}.list"
        listing.write_bytes(b"".join(path.encode("utf-8", "surrogateescape") + b"\0" for path in paths))
        temporary = dest / f"layer-{index}.tar.gz"
        uncompressed_hash, compressed_hash, size = hashlib.sha256(), hashlib.sha256(), 0
        # Numeric owners, xattrs (capabilities), ACLs, links and device nodes.
        args = ["tar", "--create", "--file=-", "--no-recursion", "--numeric-owner", "--xattrs", "--xattrs-include=*", "--acls", "--directory=" + str(root), "--null", "--verbatim-files-from", "--files-from=" + str(listing)]
        with subprocess.Popen(args, stdout=subprocess.PIPE) as process:
            with temporary.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=1) as archive:
                while chunk := process.stdout.read(8 * 1024 * 1024):
                    uncompressed_hash.update(chunk)
                    size += len(chunk)
                    archive.write(chunk)
            if process.wait() != 0:
                raise RuntimeError(f"tar failed for layer {index}")
        with temporary.open("rb") as stream:
            while chunk := stream.read(8 * 1024 * 1024):
                compressed_hash.update(chunk)
        digest = compressed_hash.hexdigest()
        compressed = temporary.stat().st_size
        if compressed >= REGISTRY_LAYER_LIMIT_BYTES:
            raise RuntimeError(f"layer {index} is {compressed} bytes, over the registry limit")
        temporary.rename(blobs / digest)
        listing.unlink()
        return {"digest": digest, "diff_id": uncompressed_hash.hexdigest(), "compressed": compressed, "unpacked": size, "paths": len(paths)}

    # zlib releases the GIL, so threads compress layers in parallel.
    with concurrent.futures.ThreadPoolExecutor(max_workers=os.cpu_count() or 2) as pool:
        layers = list(pool.map(lambda item: layer(*item), enumerate([directories] + groups)))

    def blob(value, media):
        data = json.dumps(value, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(data).hexdigest()
        (blobs / digest).write_bytes(data)
        return {"mediaType": media, "digest": "sha256:" + digest, "size": len(data)}

    source = pathlib.Path(repo)
    runner_version = re.search(r"^ARG RUNNER_VERSION=(\S+)$", (source / "images/ubuntu-24.04-js/Dockerfile").read_text(), re.M).group(1)
    lock = json.loads((source / "images/ubuntu-24.04-full/upstream.json").read_text())
    revision = subprocess.check_output(["git", "-C", repo, "rev-parse", "HEAD"], text=True).strip()
    config = blob({
        "architecture": "amd64", "os": "linux",
        "config": {
            "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C.UTF-8"],
            "Cmd": ["/sbin/init"], "StopSignal": "SIGRTMIN+3",
            "Labels": {"org.opencontainers.image.source": "https://github.com/Fanzzzd/EraInfra", "org.opencontainers.image.revision": revision, "org.opencontainers.image.licenses": "Apache-2.0", "dev.erainfra.actions-runner.version": runner_version, "dev.erainfra.runner-images.commit": lock["commit"]},
        },
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + item["diff_id"] for item in layers]},
    }, "application/vnd.oci.image.config.v1+json")
    manifest = blob({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": config, "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": "sha256:" + item["digest"], "size": item["compressed"]} for item in layers]}, "application/vnd.oci.image.manifest.v1+json")
    manifest["annotations"] = {"org.opencontainers.image.ref.name": "candidate"}
    (dest / "index.json").write_text(json.dumps({"schemaVersion": 2, "manifests": [manifest]}))
    (dest / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}\n')
    measurements = {"compressed_bytes": sum(item["compressed"] for item in layers), "unpacked_tar_bytes": sum(item["unpacked"] for item in layers), "layer_count": len(layers), "largest_compressed_layer_bytes": max(item["compressed"] for item in layers), "layers": layers, "manifest_digest": manifest["digest"], "source_revision": revision, "runner_images_commit": lock["commit"]}
    (pathlib.Path(evidence) / "measurements.json").write_text(json.dumps(measurements, indent=2) + "\n")
    print(json.dumps(measurements))


if __name__ == "__main__":
    operations = {"verify": verify, "overlay": overlay, "environment": environment, "pack": pack}
    operations[sys.argv[1]](*sys.argv[2:])
