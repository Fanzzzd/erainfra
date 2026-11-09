#!/usr/bin/env python3
"""Verify upstream order, reuse integration pins, and write a single-layer OCI image."""
import gzip
import hashlib
import json
import pathlib
import re
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


def pack(root, destination, evidence, repo):
    dest = pathlib.Path(destination)
    blobs = dest / "blobs/sha256"
    blobs.mkdir(parents=True)
    uncompressed_hash = hashlib.sha256()
    compressed_hash = hashlib.sha256()
    size = 0
    temporary = dest / "layer.tar.gz"
    # tar emits numeric owners, capabilities, links, and device nodes. Pseudo
    # filesystems are unmounted. Do not follow the skel/home symlinks.
    args = ["tar", "--create", "--file=-", "--sort=name", "--numeric-owner", "--xattrs", "--acls", "--one-file-system", "--directory=" + root, "."]
    with subprocess.Popen(args, stdout=subprocess.PIPE) as process:
        with temporary.open("wb") as raw, gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=1) as archive:
            while chunk := process.stdout.read(8 * 1024 * 1024):
                uncompressed_hash.update(chunk)
                size += len(chunk)
                archive.write(chunk)
        if process.wait() != 0:
            raise RuntimeError("tar failed")
    with temporary.open("rb") as stream:
        while chunk := stream.read(8 * 1024 * 1024):
            compressed_hash.update(chunk)
    layer_sha = compressed_hash.hexdigest()
    compressed_size = temporary.stat().st_size
    temporary.rename(blobs / layer_sha)

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
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + uncompressed_hash.hexdigest()]},
    }, "application/vnd.oci.image.config.v1+json")
    manifest = blob({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": config, "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": "sha256:" + layer_sha, "size": compressed_size}]}, "application/vnd.oci.image.manifest.v1+json")
    manifest["annotations"] = {"org.opencontainers.image.ref.name": "candidate"}
    (dest / "index.json").write_text(json.dumps({"schemaVersion": 2, "manifests": [manifest]}))
    (dest / "oci-layout").write_text('{"imageLayoutVersion":"1.0.0"}\n')
    measurements = {"compressed_layer_bytes": compressed_size, "unpacked_layer_bytes": size, "manifest_digest": manifest["digest"], "source_revision": revision, "runner_images_commit": lock["commit"]}
    (pathlib.Path(evidence) / "measurements.json").write_text(json.dumps(measurements, indent=2) + "\n")
    print(json.dumps(measurements))


if __name__ == "__main__":
    operations = {"verify": verify, "overlay": overlay, "environment": environment, "pack": pack}
    operations[sys.argv[1]](*sys.argv[2:])
