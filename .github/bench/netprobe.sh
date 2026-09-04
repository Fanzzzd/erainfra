#!/bin/sh
# Egress from the job's point of view, run identically on `ubuntu-latest` and
# on a Profile. Exists because the first Firecracker week showed
# actions/checkout taking 150-214 s where hosted takes 19 s, and a 5-minute
# npm fetch stall inside pnpm/action-setup, while the work between them ran
# faster than hosted. Prints `net.<label>.<probe>=<value>` lines and a
# Markdown table to $GITHUB_STEP_SUMMARY when set.
set -eu

label=${1:?usage: netprobe.sh <label>}
scratch=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/rc-netprobe-XXXXXX")
trap 'rm -rf "$scratch"' EXIT

report() {
  printf 'net.%s.%s=%s\n' "$label" "$1" "$2"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '| %s | %s | %s |\n' "$label" "$1" "$2" >>"$GITHUB_STEP_SUMMARY"
  fi
}
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '\n### netprobe %s\n\n' "$label"
    printf '| leg | probe | value |\n|---|---|---|\n'
  } >>"$GITHUB_STEP_SUMMARY"
fi

iface=$(ip -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p')
report iface "${iface:-unknown}"
report mtu "$(cat "/sys/class/net/${iface:-eth0}/mtu" 2>/dev/null || echo unavailable)"
if command -v ethtool >/dev/null 2>&1 && [ -n "$iface" ]; then
  report offloads "$(ethtool -k "$iface" 2>/dev/null | grep -E '^(tcp-segmentation-offload|generic-segmentation-offload|generic-receive-offload|rx-checksumming|tx-checksumming):' | sed 's/: /=/' | tr '\n' ' ')"
else
  report offloads "ethtool absent"
fi
report resolv "$(grep -E '^nameserver' /etc/resolv.conf 2>/dev/null | awk '{print $2}' | tr '\n' ' ')"

# Path MTU: a 1472-byte payload plus headers is exactly 1500; a blackhole
# between here and the internet shows up as loss on the DF probe only.
if command -v ping >/dev/null 2>&1; then
  report pmtu_1500_df "$(ping -M do -s 1472 -c 3 -W 2 1.1.1.1 2>&1 | grep -oE '[0-9]+ received|[0-9]+% packet loss|message too long' | tr '\n' ' ')"
else
  report pmtu_1500_df "ping absent"
fi

# Three downloads each from the three hosts a JavaScript CI job actually pulls
# from. Numbers are seconds to first byte, total seconds, and MiB/s; a stall
# shows up as a total far above size/speed.
fetch() {
  name=$1
  url=$2
  n=1
  while [ "$n" -le 3 ]; do
    out=$(curl -sS -L -o /dev/null --max-time 300 \
      -w '%{time_connect} %{time_starttransfer} %{time_total} %{size_download} %{http_code}' "$url" 2>&1) || out="FAILED $out"
    case "$out" in
      FAILED*) report "${name}_$n" "$out" ;;
      *)
        report "${name}_$n" "$(printf '%s' "$out" | awk '{ printf "connect=%.2fs ttfb=%.2fs total=%.2fs size=%dMiB speed=%.1fMiB/s http=%s", $1, $2, $3, $4/1048576, ($3 > 0 ? $4/1048576/$3 : 0), $5 }')"
        ;;
    esac
    n=$((n + 1))
  done
}
# ~200 MiB, the runner's own release asset, served from objects.githubusercontent.com after a redirect.
fetch github_release "https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-x64-2.336.0.tar.gz"
# ~22 MiB from the npm registry CDN.
fetch npm_tarball "https://registry.npmjs.org/typescript/-/typescript-5.9.2.tgz"
# ~5 MiB from the codeload host actions/checkout talks to for tarballs.
fetch codeload "https://codeload.github.com/Fanzzzd/erainfra/tar.gz/refs/heads/main"

t0=$(date +%s.%N)
if git clone -q --depth 1 https://github.com/Fanzzzd/erainfra.git "$scratch/clone" 2>"$scratch/clone.err"; then
  report git_clone_depth1 "$(awk -v a="$t0" -v b="$(date +%s.%N)" 'BEGIN { printf "%.2fs", b - a }')"
else
  report git_clone_depth1 "FAILED $(tr '\n' ' ' <"$scratch/clone.err")"
fi
