#!/bin/sh
# ponytail: smallest offline check of image.sh's builder logic — nixpacks asset triples per platform
# and the Dockerfile-vs-nixpacks choice. No docker, no network. Run: sh deploy/build.test.sh
set -eu
S="$(CDPATH= cd "$(dirname "$0")" && pwd)/image.sh"

asset() { sh "$S" _asset "$1" "$2"; }
eq() { [ "$2" = "$3" ] || { echo "FAIL $1: '$2' != '$3'"; exit 1; }; }

eq "linux/x86_64"  "$(asset linux  x86_64)"  "nixpacks-v1.41.0-x86_64-unknown-linux-musl.tar.gz"
eq "linux/aarch64" "$(asset linux  aarch64)" "nixpacks-v1.41.0-aarch64-unknown-linux-musl.tar.gz"
eq "darwin/x86_64" "$(asset Darwin x86_64)"  "nixpacks-v1.41.0-x86_64-apple-darwin.tar.gz"
eq "darwin/arm64"  "$(asset Darwin arm64)"   "nixpacks-v1.41.0-aarch64-apple-darwin.tar.gz"

d=$(mktemp -d)
eq "empty dir → nixpacks" "$(sh "$S" _builder "$d")" "nixpacks"
: > "$d/Dockerfile"
eq "Dockerfile → docker" "$(sh "$S" _builder "$d")" "docker"
rm -rf "$d"

echo "✅ build.test.sh ok"
