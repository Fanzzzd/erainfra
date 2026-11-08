#!/bin/sh
# deploy/infra/relay.sh against stubs, as the runbook runs it: an operator with sudo on a Linux
# host.
#
#   sh deploy/infra/relay.test.sh
#
# sudo is a stub that maps /etc, /usr/local and /var/lib under a sandbox root. systemctl, curl,
# ss and uname are stubs that record what they were asked. The release tarball is a local fake;
# the cases that install it run a copy of relay.sh whose pinned digest is the fake's, and one
# case runs the real file to show the pin refuses it. Nothing here needs root, a network,
# Convex or Let's Encrypt.
set -eu

HERE=$(CDPATH='' cd "$(dirname "$0")" && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

FAILURES="$WORK/failures"
: > "$FAILURES"
ok()   { printf '  \033[32mok\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31mFAIL\033[0m %s\n' "$*" >&2; printf '%s\n' "$*" >> "$FAILURES"; }
check() { # check <description> <command...>
  d=$1
  shift
  if "$@"; then ok "$d"; else fail "$d"; fi
}

printf 'relay.sh\n' >&2

if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -s sh "$HERE/relay.sh" > "$WORK/shellcheck.out" 2>&1; then
    ok "relay.sh passes shellcheck"
  else
    fail "relay.sh fails shellcheck"
    sed 's/^/      | /' "$WORK/shellcheck.out" >&2
  fi
else
  ok "shellcheck is not installed here; CI runs it"
fi

# A stand-in for n0's release asset: the same layout (./iroh-relay at the top), a binary that
# answers --version as clap does.
mkdir -p "$WORK/asset"
# shellcheck disable=SC2016 # the fake expands $1 when it runs
printf '#!/bin/sh\n[ "$1" = --version ] && echo "iroh-relay 1.4.1"\n' > "$WORK/asset/iroh-relay"
chmod 755 "$WORK/asset/iroh-relay"
(cd "$WORK/asset" && tar -czf "$WORK/fake.tar.gz" ./iroh-relay)
if command -v sha256sum >/dev/null; then
  FAKE_SHA=$(sha256sum "$WORK/fake.tar.gz" | cut -d' ' -f1)
else
  FAKE_SHA=$(shasum -a 256 "$WORK/fake.tar.gz" | cut -d' ' -f1)
fi
sed "s/^IROH_RELAY_SHA256_AARCH64=.*/IROH_RELAY_SHA256_AARCH64=$FAKE_SHA/" "$HERE/relay.sh" > "$WORK/relay-fake-pin.sh"
grep -q "^IROH_RELAY_SHA256_AARCH64=$FAKE_SHA$" "$WORK/relay-fake-pin.sh" || {
  echo "could not pin the fake tarball's digest" >&2
  exit 1
}

TOKEN_A=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

# One sandbox per case: <case>/bin (stubs), <case>/root (system paths), <case>/home.
sandbox() {
  C="$WORK/$1"
  mkdir -p "$C/bin" "$C/root" "$C/home"
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
exec "\${args[@]}"
EOF
  cat > "$C/bin/systemctl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$C/systemctl.log"
case "\$1" in
  show) [ -f "$C/node.env" ] && cat "$C/node.env" ;;
esac
exit 0
EOF
  # The Convex check prints \$CURL_CODE and keeps the header it read on stdin; healthz fails.
  cat > "$C/bin/curl" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$C/curl.log"
case "\$*" in
  *api/v1/relay/access*) cat > "$C/curl.stdin"; printf '%s' "\${CURL_CODE:-403}"; exit 0 ;;
esac
exit 7
EOF
  # SS_BUSY_PORT is held by another process; SS_BUSY_FLAGS (-Hltnp or -Hlunp) narrows it to TCP
  # or UDP.
  cat > "$C/bin/ss" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >> "$C/ss.log"
case "\$*" in "\${SS_BUSY_FLAGS:-}"*":\${SS_BUSY_PORT:-none}") echo "LISTEN 0 4096 *:\$SS_BUSY_PORT *:* users:((\"nginx\",pid=812,fd=6))" ;; esac
exit 0
EOF
  cat > "$C/bin/uname" <<'EOF'
#!/bin/sh
case "$1" in -s) echo Linux ;; -m) echo aarch64 ;; *) echo Linux ;; esac
EOF
  chmod +x "$C/bin/"*
}

relay() { # relay <case> <script> [VAR=value ...]
  c=$1
  script=$2
  shift 2
  (cd "$WORK/$c" && env HOME="$WORK/$c/home" PATH="$WORK/$c/bin:/usr/bin:/bin" \
    ERAINFRA_RELAY_HOSTNAME=relay.on99.ai ERAINFRA_RELAY_CONTACT=ops@on99.ai \
    ERAINFRA_RELAY_TARBALL="$WORK/fake.tar.gz" "$@" sh "$script") > "$WORK/$c/out" 2>&1
}

SITE=https://example-123.convex.site

# --- a first install with Let's Encrypt and a generated secret ---------------------------------------
sandbox fresh
if relay fresh "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE/" CURL_CODE=503; then
  ok "installs on a fresh host"
else
  fail "fresh install failed: $(tail -3 "$WORK/fresh/out")"
fi
R="$WORK/fresh/root"
cfg="$R/etc/erainfra-relay/config.toml"
check "installs the checked binary as /usr/local/libexec/iroh-relay" \
  sh -c "'$R/usr/local/libexec/iroh-relay' --version | grep -qx 'iroh-relay 1.4.1'"
check "admits through Convex's access route (trailing slash dropped)" \
  grep -qx "url = \"$SITE/api/v1/relay/access\"" "$cfg"
check "puts [access.http] in the config and no other access mode" \
  sh -c "grep -qx '\[access.http\]' '$cfg' && ! grep -Eq '^access *=|allowlist|shared_token|everyone' '$cfg'"
check "requests a Let's Encrypt certificate for the hostname" \
  sh -c "grep -qx 'hostname = \"relay.on99.ai\"' '$cfg' && grep -qx 'cert_mode = \"LetsEncrypt\"' '$cfg' && grep -qx 'contact = \"ops@on99.ai\"' '$cfg' && grep -qx 'cert_dir = \"/var/lib/erainfra-relay/certs\"' '$cfg'"
check "binds HTTPS on 443, HTTP on 80 and QUIC address discovery on 7842" \
  sh -c "grep -qx 'https_bind_addr = \"\[::\]:443\"' '$cfg' && grep -qx 'http_bind_addr = \"\[::\]:80\"' '$cfg' && grep -qx 'quic_bind_addr = \"\[::\]:7842\"' '$cfg' && grep -qx 'enable_quic_addr_discovery = true' '$cfg'"
check "serves no metrics unless asked" grep -qx 'enable_metrics = false' "$cfg"
token=$(sed -n 's/^IROH_RELAY_HTTP_BEARER_TOKEN=//p' "$R/etc/erainfra-relay/relay.env" 2>/dev/null || true)
check "generates a 256-bit secret into relay.env" sh -c "printf '%s' '$token' | grep -Eqx '[0-9a-f]{64}'"
check "keeps the secret out of the config file" sh -c "! grep -q '$token' '$cfg'"
unit="$R/etc/systemd/system/erainfra-relay.service"
check "runs as erainfra-relay with only CAP_NET_BIND_SERVICE" \
  sh -c "grep -qx 'User=erainfra-relay' '$unit' && grep -qx 'CapabilityBoundingSet=CAP_NET_BIND_SERVICE' '$unit' && grep -qx 'AmbientCapabilities=CAP_NET_BIND_SERVICE' '$unit' && grep -qx 'NoNewPrivileges=yes' '$unit' && grep -qx 'ProtectSystem=strict' '$unit'"
check "refuses to start without its config, which would mean an open plain-HTTP relay" \
  grep -qx 'AssertPathExists=/etc/erainfra-relay/config.toml' "$unit"
check "reads the secret from relay.env" grep -qx 'EnvironmentFile=/etc/erainfra-relay/relay.env' "$unit"
check "enables and restarts the unit" \
  sh -c "grep -qx 'enable erainfra-relay' '$WORK/fresh/systemctl.log' && grep -qx 'restart erainfra-relay' '$WORK/fresh/systemctl.log'"
check "asks Convex with the secret on stdin" \
  grep -qx "Authorization: Bearer $token" "$WORK/fresh/curl.stdin"
check "never puts the secret in argv" \
  sh -c "! grep -q '$token' '$WORK/fresh/curl.log' '$WORK/fresh/sudo.log' '$WORK/fresh/systemctl.log'"
check "says Convex has no secret and how to set it" \
  sh -c "grep -q 'Convex has no RELAY_ACCESS_TOKEN' '$WORK/fresh/out' && grep -q 'npx convex env set --prod RELAY_ACCESS_TOKEN --from-file' '$WORK/fresh/out'"
check "checks every port before installing" \
  sh -c "grep -q 'sport = :443' '$WORK/fresh/ss.log' && grep -q 'sport = :80' '$WORK/fresh/ss.log' && grep -q 'sport = :7842' '$WORK/fresh/ss.log'"
check "prints the plain URL for every Node's ERAINFRA_MESH_RELAYS, in systemd's single quotes" \
  sh -c "grep -qF \"Environment='ERAINFRA_MESH_RELAYS=[\\\"https://relay.on99.ai\\\"]'\" '$WORK/fresh/out' && ! grep -q quic_port '$WORK/fresh/out'"

# --- QUIC address discovery on udp/443, for a cloud security list that blocks udp/7842 --------------
sandbox udp443
if relay udp443 "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" ERAINFRA_RELAY_QUIC_PORT=443; then
  U="$WORK/udp443"
  check "binds QUIC address discovery on udp/443 beside HTTPS on tcp/443" \
    sh -c "grep -qx 'quic_bind_addr = \"\[::\]:443\"' '$U/root/etc/erainfra-relay/config.toml' && grep -qx 'https_bind_addr = \"\[::\]:443\"' '$U/root/etc/erainfra-relay/config.toml' && grep -qx 'enable_quic_addr_discovery = true' '$U/root/etc/erainfra-relay/config.toml'"
  check "checks udp/443 and tcp/443 before installing, and not udp/7842" \
    sh -c "grep -qx -- '-Hlunp sport = :443' '$U/ss.log' && grep -qx -- '-Hltnp sport = :443' '$U/ss.log' && ! grep -q 7842 '$U/ss.log'"
  check "names udp/443 in its log lines" \
    sh -c "grep -q 'runs https://relay.on99.ai/ (tcp/443, tcp/80, udp/443)' '$U/out' && grep -q 'open tcp/443, tcp/80 and udp/443' '$U/out' && ! grep -q 7842 '$U/out'"
  check "prints the ERAINFRA_MESH_RELAYS entry with quic_port 443" \
    grep -qF "Environment='ERAINFRA_MESH_RELAYS=[{\"url\":\"https://relay.on99.ai\",\"quic_port\":443}]'" "$U/out"
  check "says a Node needs a release that reads the quic_port form" \
    grep -q 'An older one refuses it with "ERAINFRA_MESH_RELAYS must be a JSON URL array"' "$U/out"
else
  fail "install with ERAINFRA_RELAY_QUIC_PORT=443 failed: $(tail -3 "$WORK/udp443/out")"
fi

# --- a secret from a file, then a re-run that keeps it ----------------------------------------------
sandbox given
printf '%s\n' "$TOKEN_A" > "$WORK/given/home/token"
if relay given "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" \
  ERAINFRA_RELAY_ACCESS_TOKEN_FILE="$WORK/given/home/token" CURL_CODE=403; then
  check "takes the secret from ERAINFRA_RELAY_ACCESS_TOKEN_FILE" \
    grep -qx "IROH_RELAY_HTTP_BEARER_TOKEN=$TOKEN_A" "$WORK/given/root/etc/erainfra-relay/relay.env"
  check "reports that Convex holds the same secret, and asks for nothing" \
    sh -c "grep -q 'Convex holds this relay' '$WORK/given/out' && ! grep -q 'convex env set' '$WORK/given/out'"
else
  fail "install with a token file failed: $(tail -3 "$WORK/given/out")"
fi
if relay given "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" CURL_CODE=403; then
  check "keeps the installed secret on a re-run" \
    grep -qx "IROH_RELAY_HTTP_BEARER_TOKEN=$TOKEN_A" "$WORK/given/root/etc/erainfra-relay/relay.env"
  check "does not reinstall the same release" grep -q 'already installed' "$WORK/given/out"
else
  fail "re-run failed: $(tail -3 "$WORK/given/out")"
fi
sandbox mismatch
printf '%s\n' "$TOKEN_A" > "$WORK/mismatch/home/token"
relay mismatch "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" \
  ERAINFRA_RELAY_ACCESS_TOKEN_FILE="$WORK/mismatch/home/token" CURL_CODE=401 || true
check "says when Convex holds a different secret" \
  sh -c "grep -q 'Convex holds a different RELAY_ACCESS_TOKEN' '$WORK/mismatch/out' && grep -q 'convex env set' '$WORK/mismatch/out'"

# --- refusals before anything is installed ----------------------------------------------------------
nothing_installed() {
  [ ! -e "$WORK/$1/root/usr/local/libexec/iroh-relay" ] && [ ! -e "$WORK/$1/root/etc/systemd/system/erainfra-relay.service" ]
}
sandbox pin
if relay pin "$HERE/relay.sh" ERAINFRA_CONVEX_SITE="$SITE"; then
  fail "installed a tarball whose digest is not the pinned one"
elif grep -q 'expected 3fc0c2d67c1cd66250bf82f3e2f17a985b7081a3d272186bad9d63e3f2347b38; nothing was installed' "$WORK/pin/out" && nothing_installed pin; then
  ok "refuses a tarball that does not match n0's pinned digest, before installing anything"
else
  fail "wrong refusal for a bad digest: $(tail -2 "$WORK/pin/out")"
fi

sandbox busy
if relay busy "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" SS_BUSY_PORT=443; then
  fail "installed over a port another process holds"
elif grep -q 'tcp/443 is already in use on this host: .*nginx' "$WORK/busy/out" && nothing_installed busy; then
  ok "names the process holding tcp/443 and installs nothing"
else
  fail "wrong refusal for a busy port: $(tail -2 "$WORK/busy/out")"
fi

sandbox busyudp
if relay busyudp "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" ERAINFRA_RELAY_QUIC_PORT=443 \
  SS_BUSY_FLAGS=-Hlunp SS_BUSY_PORT=443; then
  fail "installed with udp/443 held by another process"
elif grep -q 'udp/443 is already in use on this host: .*nginx' "$WORK/busyudp/out" && nothing_installed busyudp; then
  ok "names the process holding udp/443 when QUIC address discovery moves there"
else
  fail "wrong refusal for a busy udp/443: $(tail -2 "$WORK/busyudp/out")"
fi

for bad in 0 65536 abc 7842x ''; do
  sandbox "badquic$bad"
  if relay "badquic$bad" "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" ERAINFRA_RELAY_QUIC_PORT="$bad"; then
    if [ -z "$bad" ]; then
      ok "an empty ERAINFRA_RELAY_QUIC_PORT means the default"
    else
      fail "accepted ERAINFRA_RELAY_QUIC_PORT=$bad"
    fi
  elif [ -n "$bad" ] && grep -q 'ERAINFRA_RELAY_QUIC_PORT must be a UDP port from 1 to 65535' "$WORK/badquic$bad/out" && nothing_installed "badquic$bad"; then
    ok "refuses ERAINFRA_RELAY_QUIC_PORT=$bad before installing anything"
  else
    fail "wrong outcome for ERAINFRA_RELAY_QUIC_PORT=$bad: $(tail -2 "$WORK/badquic$bad/out")"
  fi
done

sandbox nohost
if relay nohost "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" ERAINFRA_RELAY_HOSTNAME=; then
  fail "ran without a hostname"
else
  check "refuses without ERAINFRA_RELAY_HOSTNAME" grep -q 'set ERAINFRA_RELAY_HOSTNAME' "$WORK/nohost/out"
fi

sandbox nosite
if relay nosite "$WORK/relay-fake-pin.sh"; then
  fail "ran without a Convex site"
else
  check "refuses without ERAINFRA_CONVEX_SITE when no Infra Agent unit names one" \
    grep -q 'set ERAINFRA_CONVEX_SITE' "$WORK/nosite/out"
fi

sandbox httpsite
if relay httpsite "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE=http://example.convex.site; then
  fail "accepted a plain-http Convex site, which would send the secret in clear"
else
  check "refuses a plain-http Convex site" grep -q 'set ERAINFRA_CONVEX_SITE' "$WORK/httpsite/out"
fi

sandbox shorttoken
printf 'too-short\n' > "$WORK/shorttoken/home/token"
if relay shorttoken "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" \
  ERAINFRA_RELAY_ACCESS_TOKEN_FILE="$WORK/shorttoken/home/token"; then
  fail "accepted a 9-character secret"
elif grep -q 'must be 32 to 512 characters' "$WORK/shorttoken/out" && nothing_installed shorttoken; then
  ok "refuses a short secret before installing anything"
else
  fail "wrong refusal for a short secret: $(tail -2 "$WORK/shorttoken/out")"
fi

sandbox nocontact
if relay nocontact "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" ERAINFRA_RELAY_CONTACT=; then
  fail "asked Let's Encrypt for a certificate with no contact"
else
  check "refuses Let's Encrypt without a contact email" grep -q 'set ERAINFRA_RELAY_CONTACT' "$WORK/nocontact/out"
fi

# --- the Convex site from the Infra Agent's unit, manual certificates, metrics ----------------------
sandbox manual
printf 'ERAINFRA_CONVEX_SITE=%s ERAINFRA_MESH_SOCKET=/run/erainfra-mesh/control.sock\n' "$SITE" > "$WORK/manual/node.env"
printf 'CERT\n' > "$WORK/manual/home/cert.pem"
printf 'KEY\n' > "$WORK/manual/home/key.pem"
if relay manual "$WORK/relay-fake-pin.sh" ERAINFRA_RELAY_CONTACT= \
  ERAINFRA_RELAY_CERT_FILE="$WORK/manual/home/cert.pem" ERAINFRA_RELAY_KEY_FILE="$WORK/manual/home/key.pem" \
  ERAINFRA_RELAY_METRICS=127.0.0.1:9090 ERAINFRA_RELAY_BIND=0.0.0.0; then
  M="$WORK/manual/root/etc/erainfra-relay"
  check "reads the Convex site from erainfra-node.service" \
    grep -qx "url = \"$SITE/api/v1/relay/access\"" "$M/config.toml"
  check "serves a given certificate, copied beside the config" \
    sh -c "grep -qx 'cert_mode = \"Manual\"' '$M/config.toml' && grep -qx 'manual_key_path = \"/etc/erainfra-relay/key.pem\"' '$M/config.toml' && grep -qx KEY '$M/key.pem' && ! grep -q LetsEncrypt '$M/config.toml'"
  check "serves metrics only on the loopback address given" \
    sh -c "grep -qx 'enable_metrics = true' '$M/config.toml' && grep -qx 'metrics_bind_addr = \"127.0.0.1:9090\"' '$M/config.toml'"
  check "binds IPv4 only when asked" grep -qx 'https_bind_addr = "0.0.0.0:443"' "$M/config.toml"
else
  fail "manual-certificate install failed: $(tail -3 "$WORK/manual/out")"
fi

sandbox publicmetrics
if relay publicmetrics "$WORK/relay-fake-pin.sh" ERAINFRA_CONVEX_SITE="$SITE" ERAINFRA_RELAY_METRICS=0.0.0.0:9090; then
  fail "served metrics on a public address"
else
  check "refuses metrics on a non-loopback address" grep -q 'must be a loopback address' "$WORK/publicmetrics/out"
fi

n=$(wc -l < "$FAILURES" | tr -d ' ')
if [ "$n" -ne 0 ]; then
  printf '\033[31m%s failure(s)\033[0m\n' "$n" >&2
  exit 1
fi
printf '\033[32mall relay.sh cases passed\033[0m\n' >&2
