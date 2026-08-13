#!/bin/sh
# Drive the first-run proof end to end (see verify-freshbox.ts). Starts the hub, spins up a BLANK
# privileged ubuntu container as a fresh customer box, runs the exact one command a user would paste,
# and lets the hub-side driver deploy+reach an app on it. Prints PASS/FAIL. Leaves nothing behind.
set -eu
cd "$(dirname "$0")/../.."
BOX=pl-freshbox
LOG="${SCRATCH:-/tmp}/freshbox-hub.log"

cleanup() { docker rm -f "$BOX" >/dev/null 2>&1 || true; pkill -f verify-freshbox.ts 2>/dev/null || true; }
cleanup  # clear any prior run
trap cleanup EXIT

# 1. hub (in-process driver) — waits for the box to enroll, then deploys to it.
node --experimental-strip-types prototypes/relay-experiments/verify-freshbox.ts >"$LOG" 2>&1 &
DRIVER=$!
for _ in $(seq 1 60); do grep -q HUB_READY "$LOG" 2>/dev/null && break; sleep 0.5; done
grep -q HUB_READY "$LOG" 2>/dev/null || { echo "hub failed to start:"; cat "$LOG"; exit 1; }
echo "hub up (0.0.0.0:8787)."

# 2. a genuinely blank box: privileged (for a nested docker), with NOTHING installed.
docker run -d --privileged --name "$BOX" --add-host=host.docker.internal:host-gateway ubuntu:22.04 sleep infinity >/dev/null
# nested-DinD ONLY: Docker Desktop's host fs is overlayfs and overlay-on-overlay can't mount, so the
# box's nested dockerd must use vfs. A real box (bare metal/VM/cloud) uses overlay2 natively and needs
# none of this — purely a docker-in-docker test artifact, not anything portless does.
docker exec "$BOX" sh -c 'mkdir -p /etc/docker && printf "{\"storage-driver\":\"vfs\"}\n" > /etc/docker/daemon.json'
echo "blank box up. docker at start? -> $(docker exec $BOX sh -c 'command -v docker || echo <none>')"
# curl is the single prerequisite implied by `curl … | sh` (present on essentially every real server).
docker exec "$BOX" sh -c 'apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq curl >/dev/null 2>&1'
echo "running THE ONE COMMAND a user pastes:"
echo "    curl -fsSL <hub>/agent.sh | sh -s -- --token <token> --name freshbox"

# 3. exactly that, against the hub the box reaches via host.docker.internal.
docker exec "$BOX" sh -c 'curl -fsSL http://host.docker.internal:8787/agent.sh | sh -s -- --token owner-dev-token --name freshbox' || true

# 4. let the hub-side driver finish (detect enrollment, load image, deploy, reach).
set +e; wait "$DRIVER"; rc=$?; set -e
echo "----- hub/driver log -----"; cat "$LOG"
# Probe: does a DIRECT `docker run -p` even work in this nested DinD box? (isolates portless from the
# test environment — real boxes publish ports fine, nested docker-in-docker often can't.)
echo "----- direct nested docker run -p probe (bypasses portless) -----"
docker exec "$BOX" sh -c 'docker run -d --name diag -p 19000:5000 registry:2 >/dev/null 2>&1 && sleep 2 && (curl -s -o /dev/null -w "direct -p works: HTTP %{http_code}\n" localhost:19000/v2/ || echo "direct curl failed") || docker run --rm -p 19000:5000 registry:2 2>&1 | head -3' || true
echo "----- box: what the one command installed -----"
docker exec "$BOX" sh -c 'echo "docker: $(docker --version 2>/dev/null || echo MISSING)"; echo "agent: $(ls -la ~/.portless/bin/portless-agent 2>/dev/null || echo MISSING)"' || true
[ "$rc" = 0 ] && echo "RESULT: PASS ✅" || echo "RESULT: FAIL ❌ (rc=$rc)"
exit "$rc"
