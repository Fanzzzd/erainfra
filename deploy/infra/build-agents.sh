#!/bin/sh
# Fill deploy/infra/bin/ with the Infra Agent binaries this hub serves at /agent-bin/, so a hub can
# serve the bytes itself: no Docker Hub, no third-party release host, air-gap intact.
#
# What changed with ADR 0006: this is a MIRROR, not the trust root. The installer verifies whatever
# it downloads — from here or from anywhere else — against the SHA-256 the control plane pins, and
# refuses on mismatch. "The hub compiled it" is no longer a reason to trust it.
#
# Two ways to fill the mirror, and the difference matters because agent.sh takes its bytes from here
# by default:
#
#   sh deploy/infra/build-agents.sh --from-release   # download the pinned release assets, verified
#   sh deploy/infra/build-agents.sh                  # compile them here, on a pinned toolchain
#
# --from-release is the one that cannot drift: it copies the exact attested bytes the control plane
# pins. Compiling is the offline path, and it is byte-reproducible ONLY on the toolchain the release
# used. Measured on apps/infra-agent linux/arm64 AT COMMIT 459f7cf, identical source and flags —
# 39f8bfb1…be68a under go1.25.3 and f0763eb6…1063f under go1.25.5, both 6 160 532 bytes, differing
# at char 153. Those digests are named with a commit because they are perishable: they describe that
# source, not this script. go.mod names one Go version and this script pins GOTOOLCHAIN to it, so an
# upgraded box downloads that toolchain instead of silently producing bytes every Node would then
# refuse. Either way this script checks its own output against the deployment pin before an operator
# finds out one Node at a time.
#
# Reproducible does NOT mean "only real code changes the bytes". `-s -w` strips the symbol table and
# DWARF but not the pclntab, which the runtime needs for panics and runtime.Caller, so the binary
# carries line numbers. Inserting a COMMENT above existing code shifts every later line and rewrites
# the binary; appending the same comment at end of file changes nothing. Measured, same commit:
# baseline 39f8bfb1…be68a, two comment lines mid-file 75667ebf…fe4a, the same two lines at EOF
# 39f8bfb1…be68a. If a digest moved and the diff looks like "comments only", this is why — the build
# is reproducible to the line, which is the opposite of nondeterministic.
#
#   PORTLESS_AGENT_VERSION=0.2.0-rc.5 sh …/build-agents.sh   # stamp/fetch a specific release
set -eu
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
REPO=$(CDPATH= cd "$HERE/../.." && pwd)
SRC="$REPO/apps/infra-agent"
OUT="$HERE/bin"
mkdir -p "$OUT"
log()  { printf '\033[36m[portless]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33m[portless] %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31m[portless] %s\033[0m\n' "$*" >&2; exit 1; }

FROM_RELEASE=0
for a in "$@"; do
  case "$a" in
    --from-release) FROM_RELEASE=1 ;;
    # Print the header comment down to the first line that is not one, rather than a line range a
    # later edit silently truncates.
    -h|--help) sed -n '2,${/^#/!q;p;}' "$0"; exit 0 ;;
    *) die "unknown option: $a" ;;
  esac
done

# Stamp the product version onto the binary so `portless-agent version` reports what shipped. This
# needs node only to read one field; a box without it still builds, and the binary says "dev".
VERSION="${ERAINFRA_AGENT_VERSION:-${PORTLESS_AGENT_VERSION:-}}"
if [ -n "${PORTLESS_AGENT_VERSION:-}" ] && [ -z "${ERAINFRA_AGENT_VERSION:-}" ]; then
  # Stage 1 of retiring the name (ADR 0004): both are read, the new one wins, neither is deleted.
  printf '\033[33m[erainfra] PORTLESS_AGENT_VERSION is a retired name — use ERAINFRA_AGENT_VERSION.\033[0m\n' >&2
fi
[ -n "$VERSION" ] || VERSION=$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo dev)
log "stamping version $VERSION"

# What the control plane pins, read out of the same checkout the hub runs from. Empty when this
# checkout pins nothing yet, in which case the checks below say so rather than pretending to pass.
pinned_digest() {
  node --experimental-strip-types --input-type=module -e "
    import { AGENT_RELEASE } from '$REPO/packages/backend/convex/agentRelease.ts';
    process.stdout.write(AGENT_RELEASE.infraAgent['$1'] ?? '');
  " 2>/dev/null || true
}
pinned_repo() {
  node --experimental-strip-types --input-type=module -e "
    import { AGENT_RELEASE } from '$REPO/packages/backend/convex/agentRelease.ts';
    process.stdout.write(AGENT_RELEASE.repo);
  " 2>/dev/null || true
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else die "a SHA-256 utility (sha256sum or shasum) is required"; fi
}

# The toolchain the release built with, from the one place it is declared: go.mod's go directive,
# which is also what setup-go reads in CI and what packages/release/src/go-toolchain.ts parses.
# GOTOOLCHAIN=auto would use whatever is installed as long as it is new enough, and "new enough" is
# not "the same" — a patch bump changes the bytes. A `toolchain` directive does not help: auto takes
# the LATER of the two, so it raises a floor and never caps. Only an explicit GOTOOLCHAIN pins.
GO_DIRECTIVE=$(sed -n 's/^go \([0-9][0-9.]*\)$/\1/p' "$REPO/go.mod" | head -n 1)
[ -n "$GO_DIRECTIVE" ] || die "could not read the go directive from $REPO/go.mod"
if sed -n 's/^toolchain \(.*\)$/\1/p' "$REPO/go.mod" | grep -q .; then
  die "go.mod declares a toolchain directive as well as its go directive — two sources that can disagree. Remove it; go$GO_DIRECTIVE is what both build paths pin."
fi

if [ "$FROM_RELEASE" != 1 ]; then
  # Fail here, naming the toolchain, rather than five builds later as a digest mismatch that reads
  # like tampering. An air-gapped hub whose Go is not go$GO_DIRECTIVE cannot download it and stops
  # right here — which is the intended behaviour, and --from-release is the way through.
  command -v go >/dev/null 2>&1 || die "go is not installed. This hub needs go$GO_DIRECTIVE to compile the mirror, or run: sh $0 --from-release"
  GO_REPORTED=$(GOTOOLCHAIN="go$GO_DIRECTIVE" go version 2>/dev/null | cut -d ' ' -f 3 || true)
  if [ "$GO_REPORTED" != "go$GO_DIRECTIVE" ]; then
    warn "this checkout pins go$GO_DIRECTIVE, and go reports '${GO_REPORTED:-nothing}' under GOTOOLCHAIN=go$GO_DIRECTIVE."
    warn "Go is only byte-reproducible within one toolchain, so building here would produce bytes"
    warn "  every Node refuses. If this box is offline it cannot fetch go$GO_DIRECTIVE; mirror the"
    warn "  attested release bytes instead:"
    warn "  sh $0 --from-release"
    die "refusing to build on an unpinned toolchain"
  fi
  log "compiling on $GO_REPORTED, pinned by go.mod"
fi

MISMATCH=0
for t in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64; do
  os=${t%/*}; arch=${t#*/}
  ext=""; [ "$os" = windows ] && ext=".exe"
  cpu=$arch; [ "$arch" = amd64 ] && cpu=x86_64
  target="${os}-${cpu}"
  # The mirror's names are frozen (agent.sh / agent.ps1 fetch these); the release publishes the same
  # bytes as infra-agent-<os>-<cpu>.
  mirrored="$OUT/portless-agent-${os}-${arch}${ext}"
  asset="infra-agent-${target}${ext}"
  expected=$(pinned_digest "$target")

  if [ "$FROM_RELEASE" = 1 ]; then
    repo=$(pinned_repo)
    [ -n "$repo" ] || die "could not read AGENT_RELEASE.repo — run --from-release from a full checkout"
    url="https://github.com/$repo/releases/download/v$VERSION/$asset"
    log "downloading $asset from release v$VERSION"
    tmp="$mirrored.partial"
    curl -fsSL "$url" -o "$tmp" || die "could not download $url"
    actual=$(sha256_of "$tmp")
    if [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
      rm -f "$tmp"
      die "$asset is $actual but this deployment pins $expected — refusing to mirror it"
    fi
    mv "$tmp" "$mirrored"
    chmod 755 "$mirrored"
  else
    log "building portless-agent-${os}-${arch}${ext} with go$GO_DIRECTIVE"
    (cd "$SRC" && GOTOOLCHAIN="go$GO_DIRECTIVE" CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
      go build -trimpath -buildvcs=false -ldflags="-s -w -buildid= -X main.version=$VERSION" -o "$mirrored" .)
    actual=$(sha256_of "$mirrored")
  fi

  if [ -z "$expected" ]; then
    printf '  %s  %s  (this checkout pins no digest for %s — cannot check)\n' "$actual" "$asset" "$target" >&2
  elif [ "$actual" = "$expected" ]; then
    printf '  %s  %s  matches the deployment pin\n' "$actual" "$asset" >&2
  else
    MISMATCH=1
    printf '  %s  %s  DOES NOT MATCH the pin %s\n' "$actual" "$asset" "$expected" >&2
  fi
done

if [ "$MISMATCH" = 1 ]; then
  warn "this mirror will be REFUSED by the installer, and agent.sh serves it by default."
  warn "Most likely causes, in order: this checkout is not the commit the control plane pins;"
  warn "  Go go$GO_DIRECTIVE could not be used here (check 'go version' — a patch-level difference"
  warn "  changes the bytes); or the product version stamped ($VERSION) is not the pinned one."
  warn "Fix it before enrolling a Node, or fill the mirror with the attested bytes instead:"
  warn "  sh deploy/infra/build-agents.sh --from-release"
  exit 1
fi

log "done → $OUT"
log "these are a mirror: the installer still verifies them against the control plane's pinned digest"
ls -la "$OUT" >&2
