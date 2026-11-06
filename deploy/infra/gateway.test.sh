#!/bin/sh
# deploy/infra/gateway.sh against stubs, as the runbooks run it: an operator with sudo, on a Node
# whose connect-convex agent the installer may have put where only root can read it.
#
#   sh deploy/infra/gateway.test.sh
#
# sudo is a stub that maps /etc, /usr/local and /var/lib under a sandbox root and stands in for
# root's access by opening the sandbox's "root-only" directory for the one command it runs.
# systemctl, cloudflared and curl are stubs that record what they were asked. Nothing here needs
# root, a network or Cloudflare.
set -eu

HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'chmod -R u+rwx "$WORK" 2>/dev/null; rm -rf "$WORK"' EXIT INT TERM

FAILURES="$WORK/failures"
: > "$FAILURES"
ok()   { printf '  \033[32mok\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; printf '%s\n' "$*" >> "$FAILURES"; }

# One sandbox per case: <case>/bin (stubs), <case>/root (system paths), <case>/home, and
# <case>/rootonly, a directory this user cannot enter, like /root to a non-root operator.
sandbox() {
  C="$WORK/$1"
  mkdir -p "$C/bin" "$C/root" "$C/home/.cloudflared" "$C/rootonly"
  : > "$C/home/.cloudflared/cert.pem"
  cat > "$C/bin/sudo" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$C/sudo.log"
case "\$1" in useradd|chown) exit 0 ;; esac
args=()
skip=0
for arg in "\$@"; do
  if [ "\$skip" -eq 1 ]; then skip=0; continue; fi
  case "\$arg" in
    -o|-g) skip=1 ;;
    /etc/*|/usr/local/*|/var/lib/*) args+=("$C/root\$arg") ;;
    *) args+=("\$arg") ;;
  esac
done
case "\${args[0]}" in install|tee) for a in "\${args[@]}"; do case "\$a" in "$C/root"/*) mkdir -p "\$(dirname "\$a")" ;; esac; done ;; esac
chmod 755 "$C/rootonly"
"\${args[@]}"
rc=\$?
chmod 000 "$C/rootonly"
exit \$rc
EOF
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "%s/systemctl.log"\n' "$C" > "$C/bin/systemctl"
  printf '#!/bin/sh\nexit 7\n' > "$C/bin/curl"
  cat > "$C/bin/cloudflared" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$C/cloudflared.log"
case "\$1 \$2" in
  "tunnel list") printf 'ID NAME CREATED\n6f1d0c2e-0000-4000-8000-000000000001 erainfra-gateway 2026-11-06\n' ;;
  "tunnel token") for a in "\$@"; do [ "\${prev:-}" = --cred-file ] && printf '{}' > "\$a"; prev=\$a; done ;;
esac
exit 0
EOF
  chmod +x "$C/bin/"*
}

agent() { # agent <path> <prints a gateway command: 1|0>
  mkdir -p "$(dirname "$1")"
  if [ "$2" = 1 ]; then
    printf '#!/bin/sh\necho "  -routes-file string" >&2\nexit 2\n' > "$1"
  else
    printf '#!/bin/sh\necho "unknown command" >&2\nexit 2\n' > "$1"
  fi
  chmod 755 "$1"
}

gateway() { # gateway <case> [VAR=value ...]
  c=$1
  shift
  (cd "$WORK/$c" && env HOME="$WORK/$c/home" PATH="$WORK/$c/bin:/usr/bin:/bin" ERAINFRA_ZONE=on99.ai "$@" \
    sh "$HERE/gateway.sh") > "$WORK/$c/out" 2>&1
}

printf 'gateway.sh\n' >&2

# The installer runs as root (curl | sudo bash), so the agent may sit under /root, which the
# operator running gateway.sh cannot enter. gateway.sh reads it through sudo.
sandbox rootonly
agent "$WORK/rootonly/rootonly/portless-agent" 1
chmod 000 "$WORK/rootonly/rootonly"
if gateway rootonly ERAINFRA_AGENT_BIN="$WORK/rootonly/rootonly/portless-agent"; then
  ok "takes an agent binary only root can read"
else
  fail "refused an agent binary only root can read: $(tail -1 "$WORK/rootonly/out")"
fi
copy="$WORK/rootonly/root/usr/local/libexec/erainfra-gateway"
if [ -x "$copy" ] && grep -q routes-file "$copy"; then
  ok "installs a root-owned copy for the unit"
else
  fail "no copy of the agent at /usr/local/libexec/erainfra-gateway"
fi
route_config="$WORK/rootonly/home/.cloudflared/config-erainfra-gateway.yml"
if grep -q '^tunnel: 6f1d0c2e-0000-4000-8000-000000000001$' "$route_config" 2>/dev/null; then
  ok "writes a config naming the gateway tunnel where the operator can pass it to route dns"
else
  fail "no readable config-erainfra-gateway.yml naming the tunnel"
fi
if grep -q 'route dns' "$WORK/rootonly/cloudflared.log"; then
  fail "moved DNS without ERAINFRA_GATEWAY_ROUTE_DNS=1"
else
  ok "moves no DNS by default"
fi

# With ERAINFRA_GATEWAY_ROUTE_DNS=1, route dns names its config, never a default one that may name
# another tunnel.
sandbox dns
agent "$WORK/dns/agent" 1
if gateway dns ERAINFRA_AGENT_BIN="$WORK/dns/agent" ERAINFRA_GATEWAY_ROUTE_DNS=1; then
  want="tunnel --config $WORK/dns/home/.cloudflared/config-erainfra-gateway.yml route dns --overwrite-dns 6f1d0c2e-0000-4000-8000-000000000001 *.on99.ai"
  if grep -qxF "$want" "$WORK/dns/cloudflared.log"; then
    ok "routes the wildcard with an explicit --config"
  else
    fail "route dns ran as: $(grep 'route dns' "$WORK/dns/cloudflared.log" || echo nothing)"
  fi
else
  fail "ERAINFRA_GATEWAY_ROUTE_DNS=1 failed: $(tail -1 "$WORK/dns/out")"
fi

# A binary without the gateway command is refused before anything is installed.
sandbox old
agent "$WORK/old/agent" 0
if gateway old ERAINFRA_AGENT_BIN="$WORK/old/agent"; then
  fail "accepted an agent without a gateway command"
elif grep -q 'has no gateway command' "$WORK/old/out" && [ ! -e "$WORK/old/root/usr/local/libexec/erainfra-gateway" ]; then
  ok "refuses an agent without a gateway command, before installing anything"
else
  fail "wrong refusal for an agent without a gateway command: $(tail -1 "$WORK/old/out")"
fi

# A path that holds no binary names what to do.
sandbox missing
if gateway missing ERAINFRA_AGENT_BIN="$WORK/missing/nothing-here"; then
  fail "accepted a missing agent binary"
elif grep -q 'install it with /install --role node --convex' "$WORK/missing/out"; then
  ok "refuses a missing agent binary and says how to install it"
else
  fail "wrong refusal for a missing binary: $(tail -1 "$WORK/missing/out")"
fi

n=$(wc -l < "$FAILURES" | tr -d ' ')
if [ "$n" -ne 0 ]; then
  printf '\033[31m%s failure(s)\033[0m\n' "$n" >&2
  exit 1
fi
printf '\033[32mall gateway.sh cases passed\033[0m\n' >&2
