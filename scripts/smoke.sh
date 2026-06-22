#!/usr/bin/env bash
set -euo pipefail
npm test
node --experimental-strip-types apps/api/src/server.ts &
pid=$!
trap 'kill $pid' EXIT
sleep 1
curl -fsS http://127.0.0.1:8787/health >/dev/null
# tRPC liveness via the public health procedure (GET).
curl -fsS http://127.0.0.1:8787/trpc/health >/dev/null
