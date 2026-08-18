# Runbook: run the job cache

The job cache is `apps/cache-service`: one standalone Go binary that speaks GitHub's Actions Cache
Service protocol — **both generations** — and keeps the bytes in a bucket you point it at. Jobs
reach it as an authenticated network client and nothing writable is added to any Worker, which is
the whole reason [ADR 0007](../adr/0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md)
can add a cache without touching ADR 0002's isolation contract.

**What this runbook covers:** choosing and provisioning the store, running the service, and the
bucket lifecycle rule that does the eviction. **What it does not cover:** pointing jobs at the
service. That is stage C — it composes the per-Attempt environment and adds the cache endpoint to
`apps/runtime/internal/netpolicy`'s allowed egress destinations. Until stage C lands, this service
runs and answers but nothing calls it.

---

## 1. Decide where the bucket lives

This is an operator's decision, not an architectural one, because the right answer depends on where
your Workers are.

### Case A — your Workers are on your own network

Put the store on the same LAN. MinIO, Garage, SeaweedFS and Ceph all speak the S3 API and all fit
the four-variable contract below. This is where the speedup actually comes from: the win is
bandwidth and latency, not the storage vendor.

**Put it on a host that is not a Worker.** This is a constraint, not a preference, and it has two
independent reasons:

- **A Worker cannot reach a store on itself.** ADR 0002's nftables table `inet runner-center` drops
  guest traffic to the host, so a bucket served from a Worker is unreachable from that Worker's own
  jobs. Making it reachable means punching a hole in exactly the rule that is verified at readiness
  — so the hole would have to be rendered and verified too.
- **It would be the wrong shape even if it worked.** Persistent writable storage on a machine that
  also runs untrusted jobs sits inside the blast radius. The isolation argument rests on the cache
  being somewhere a job can only reach as an authenticated network client.

A NAS, a small always-on box, or the machine already running
`runner-center-controller@<profile>` are all fine. Size it for your fleet's working set: this
repository's own `check` job restores 329 MiB per warm run.

```bash
# One workable shape, on the store host. Any S3-compatible server will do.
# certs/ holds public.crt and private.key for this host — see the TLS note in §2,
# which is a requirement here rather than a nicety.
#
# The API port is published; the admin console is bound to loopback, because it
# is reached over an SSH tunnel by a human occasionally and by nothing else ever.
mkdir -p /srv/erainfra-cache /srv/erainfra-cache-certs
podman run -d --name erainfra-cache-store \
  -p 9000:9000 -p 127.0.0.1:9001:9001 \
  -v /srv/erainfra-cache:/data \
  -v /srv/erainfra-cache-certs:/certs:ro \
  -e MINIO_ROOT_USER="$store_root_user" \
  -e MINIO_ROOT_PASSWORD="$store_root_password" \
  quay.io/minio/minio server /data --certs-dir /certs --console-address ":9001"
```

Then create a bucket and, **separately, a credential scoped to that bucket only**. The root
credential above administers the store and must never be what the cache service holds; the service
needs `s3:GetObject`, `s3:PutObject`, `s3:ListBucket` and the multipart calls
(`s3:AbortMultipartUpload`) on one bucket, and nothing else anywhere.

```bash
mc alias set erainfra https://store.lan:9000 "$store_root_user" "$store_root_password"
mc mb erainfra/erainfra-cache
# Keep these two named apart from the root pair: they are what §2 writes to disk
# and what ERAINFRA_CACHE_S3_ACCESS_KEY names.
cache_access_key=erainfra-cache
cache_secret=$(openssl rand -base64 36)
mc admin user add erainfra "$cache_access_key" "$cache_secret"
mc admin policy attach erainfra readwrite --user "$cache_access_key"   # narrow this to the one bucket
```

### Case B — no colocated store, or a fleet spread across sites

**R2 over S3, decisively.** A CI cache is egress-dominated — written once per key, restored by
every job on every branch — so on S3 that egress is most of the bill and on R2 it is zero. R2 speaks
the S3 API, so choosing it now costs nothing if the fleet later consolidates onto one site.

```bash
ERAINFRA_CACHE_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
ERAINFRA_CACHE_S3_REGION=auto
ERAINFRA_CACHE_S3_PATH_STYLE=true
```

Use a bucket-scoped API token, not an account token.

---

## 2. Configure the service

Every variable is new, so every variable is spelled `ERAINFRA_CACHE_*`. Nothing here is on
[CONTEXT.md](../../CONTEXT.md) rule 4's frozen list.

| variable                          | required | default                        | what it is                                             |
| --------------------------------- | -------- | ------------------------------ | ------------------------------------------------------ |
| `ERAINFRA_CACHE_S3_ENDPOINT`      | yes      | —                              | `http(s)://host:port` of the store                     |
| `ERAINFRA_CACHE_S3_BUCKET`        | yes      | —                              | bucket name                                            |
| `ERAINFRA_CACHE_S3_ACCESS_KEY`    | yes      | —                              | access key id                                          |
| `ERAINFRA_CACHE_S3_SECRET`        | yes      | —                              | secret key; prefer `ERAINFRA_CACHE_S3_SECRET_FILE`     |
| `ERAINFRA_CACHE_S3_REGION`        | no       | `us-east-1`                    | signing region; R2 wants `auto`                        |
| `ERAINFRA_CACHE_S3_PREFIX`        | no       | `erainfra-cache/v1/`           | key prefix, so one bucket can hold more than the cache |
| `ERAINFRA_CACHE_S3_PATH_STYLE`    | no       | `true`                         | address the bucket as a path segment                   |
| `ERAINFRA_CACHE_SIGNING_KEY`      | yes      | —                              | HMAC secret shared with the token issuer; ≥32 bytes    |
| `ERAINFRA_CACHE_LISTEN`           | no       | `:8721`                        | listen address                                         |
| `ERAINFRA_CACHE_PUBLIC_URL`       | no       | taken from the request         | base URL jobs reach this service at                    |
| `ERAINFRA_CACHE_DOWNLOAD_MODE`    | no       | `presign`                      | `presign` or `proxy`; see below                        |
| `ERAINFRA_CACHE_DOWNLOAD_TTL`     | no       | `5m`                           | lifetime of a download URL                             |
| `ERAINFRA_CACHE_UPLOAD_TTL`       | no       | `1h`                           | lifetime of an upload URL and of a spooled upload      |
| `ERAINFRA_CACHE_LOOKUP_TIMEOUT`   | no       | `5s`                           | restore budget; overrun answers a miss                 |
| `ERAINFRA_CACHE_RESERVE_TIMEOUT`  | no       | `10s`                          | reserve/finalize budget; overrun refuses the save      |
| `ERAINFRA_CACHE_TRANSFER_TIMEOUT` | no       | `30m`                          | one request body, and the store write it drives        |
| `ERAINFRA_CACHE_MAX_ENTRY_BYTES`  | no       | `10737418240` (10 GiB)         | per-entry ceiling                                      |
| `ERAINFRA_CACHE_PART_BYTES`       | no       | `33554432` (32 MiB)            | multipart part size                                    |
| `ERAINFRA_CACHE_SPOOL_DIR`        | no       | `$TMPDIR/erainfra-cache-spool` | where in-flight uploads land                           |
| `ERAINFRA_CACHE_LOG_LEVEL`        | no       | `info`                         | `debug`, `info`, `warn`, `error`                       |

Every secret variable has a `_FILE` twin (`ERAINFRA_CACHE_SIGNING_KEY_FILE`,
`ERAINFRA_CACHE_S3_SECRET_FILE`). Prefer them: a secret in an environment variable is readable by
anything that can read `/proc`.

**Provision both secret files before the service starts.** `config.Load` opens them at startup and
refuses to run without either, so a missing file is a service that never comes up rather than one
that comes up degraded.

```bash
install -d -m 0700 /etc/erainfra
# The signing key. Generate it once and give the same value to whatever mints
# tokens — in stage C, the controller.
openssl rand -base64 48 > /etc/erainfra/cache-signing-key
# The store's secret key. This is $cache_secret from §1 — the bucket-scoped
# credential that pairs with ERAINFRA_CACHE_S3_ACCESS_KEY — and never the root
# password, which would both fail to authenticate against that access key and
# hand the service the run of the store.
printf '%s' "$cache_secret" > /etc/erainfra/cache-store-secret
chmod 600 /etc/erainfra/cache-signing-key /etc/erainfra/cache-store-secret
```

**Give the store a TLS endpoint.** `ERAINFRA_CACHE_S3_ENDPOINT` should be `https://`, and not only
because the cache bytes would otherwise cross the LAN in the clear. Uploads are signed with
`UNSIGNED-PAYLOAD` — S3's own scheme for a streamed body of known length, since the payload cannot
be hashed without buffering it — so **the signature covers the request, not the bytes**, and TLS is
what stands between an on-path attacker and rewriting a cache entry in flight. That is the same
supply-chain hole as a fork PR writing an entry, reached a different way: whoever can change those
bytes injects them into every later job that restores the key.

MinIO, Garage, SeaweedFS and Ceph all take a certificate; on a LAN an internal CA or a
`step-ca`-issued certificate is enough, and the service uses the host's trust store. If you
deliberately run cleartext anyway, you are asserting that every host that can reach that endpoint is
as trusted as the jobs' output, and the cache stops being an authenticated surface for anyone who
can get on that segment. Say so in your own runbook rather than inheriting it from this one.

**`ERAINFRA_CACHE_SPOOL_DIR` needs real disk.** A v1 upload is spooled whole before it reaches the
store, because `@actions/cache` sends 32 MiB chunks out of order and each names its own byte range;
a v2 block upload is spooled for the same reason in a different shape — the Azure protocol only
names the block order in the final commit. Budget roughly one concurrent job's entry size per job
that saves at the same time.

**Download mode.** `presign` is the default and hands the job a URL for exactly one object, by GET
only, that expires. It requires the jobs themselves to be able to reach `ERAINFRA_CACHE_S3_ENDPOINT`
— which for stage C means that endpoint is a second allowed egress destination. Use `proxy` when
the store is routable from the cache service and not from the jobs; it costs a hop for download
bytes and leaves the jobs with exactly one destination to allow.

---

## 3. Run it

```bash
install -m 0755 erainfra-cache-service /usr/local/bin/erainfra-cache-service
cat > /etc/erainfra/cache.env <<'EOF'
ERAINFRA_CACHE_LISTEN=:8721
ERAINFRA_CACHE_S3_ENDPOINT=https://store.lan:9000
ERAINFRA_CACHE_S3_BUCKET=erainfra-cache
ERAINFRA_CACHE_S3_ACCESS_KEY=erainfra-cache
EOF
chmod 600 /etc/erainfra/cache.env
```

The two `_FILE` variables are deliberately **not** in that file. `EnvironmentFile` is read by systemd
as root, but the paths inside it are opened by the _service process_, and this unit runs under
`DynamicUser=yes` — a transient identity that cannot traverse a `0700` root-owned `/etc/erainfra`.
Pointing the variables straight at those paths produces a service that fails at startup with a
permission error on a file that is plainly there. `LoadCredential=` is the way through: systemd reads
each file as root and drops a copy, readable only by this service's identity, into
`$CREDENTIALS_DIRECTORY` — which `%d` expands to.

```ini
# /etc/systemd/system/erainfra-cache-service.service
[Unit]
Description=EraInfra job cache
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/erainfra/cache.env
ExecStart=/usr/local/bin/erainfra-cache-service
Restart=always
RestartSec=5

# The secrets, read by systemd as root and handed to the service identity.
LoadCredential=cache-signing-key:/etc/erainfra/cache-signing-key
LoadCredential=cache-store-secret:/etc/erainfra/cache-store-secret
Environment=ERAINFRA_CACHE_SIGNING_KEY_FILE=%d/cache-signing-key
Environment=ERAINFRA_CACHE_S3_SECRET_FILE=%d/cache-store-secret

DynamicUser=yes
StateDirectory=erainfra-cache
Environment=ERAINFRA_CACHE_SPOOL_DIR=/var/lib/erainfra-cache/spool
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes

[Install]
WantedBy=multi-user.target
```

`LoadCredential=` needs systemd 247 or newer (`systemctl --version`). On anything older, replace the
credential block and `DynamicUser=yes` with a real service account, and grant it the access
explicitly — all three parts of it, because missing any one produces the same permission error on a
file that is plainly there:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin erainfra-cache
# 1. traverse the directory
chgrp erainfra-cache /etc/erainfra && chmod 0710 /etc/erainfra
# 2. read the files
chgrp erainfra-cache /etc/erainfra/cache-signing-key /etc/erainfra/cache-store-secret
chmod 0640 /etc/erainfra/cache-signing-key /etc/erainfra/cache-store-secret
# 3. own the spool
install -d -o erainfra-cache -g erainfra-cache -m 0700 /var/lib/erainfra-cache/spool
```

```ini
User=erainfra-cache
Group=erainfra-cache
Environment=ERAINFRA_CACHE_SIGNING_KEY_FILE=/etc/erainfra/cache-signing-key
Environment=ERAINFRA_CACHE_S3_SECRET_FILE=/etc/erainfra/cache-store-secret
```

What must not happen is the service running as root because the secrets were unreadable any other
way.

```bash
systemctl daemon-reload
systemctl enable --now erainfra-cache-service
curl -fsS http://127.0.0.1:8721/healthz     # {"ok":true}
```

`/healthz` needs no token and does not touch the store: it answers that the process is up, not that
the bucket is reachable. The truth about the store is in the log — a restore that could not read
the bucket is logged at `error` and answered as a miss, on purpose (see §5).

---

## 4. Evict with a bucket lifecycle rule, not with an eviction engine

The service does not delete anything. Give the bucket a lifecycle rule instead: it is one line of
configuration, it runs in the store rather than in a service that could be down, and it survives
this service being replaced.

GitHub evicts entries unused for 7 days and caps a repository at 10 GB. A reasonable starting point
is an age-based expiry on the whole prefix:

**The filter must be the prefix the service is configured with.** `ERAINFRA_CACHE_S3_PREFIX` is an
operator's setting and defaults to `erainfra-cache/v1/`; a rule that hardcodes the default against a
service configured with anything else matches nothing at all, and nothing is exactly what a
lifecycle rule looks like when it is working. Take the prefix from the same place the service does
rather than retyping it:

```bash
# MinIO / any store with an S3-compatible lifecycle API
set -eu
prefix=$(. /etc/erainfra/cache.env; printf '%s' "${ERAINFRA_CACHE_S3_PREFIX:-erainfra-cache/v1/}")
# The prefix is interpolated into JSON below, so refuse anything that would not
# survive it rather than emitting a document that silently will not parse.
case $prefix in
  *[!A-Za-z0-9/._-]*) echo "refusing to build a rule for prefix $prefix" >&2; exit 1 ;;
esac

# Not a predictable path: this is run as root, and another local user can put a
# symlink at a name they can guess.
rule=$(mktemp) && trap 'rm -f "$rule"' EXIT
cat > "$rule" <<EOF
{
  "Rules": [
    {
      "ID": "expire-cache-entries",
      "Status": "Enabled",
      "Filter": { "Prefix": "${prefix}" },
      "Expiration": { "Days": 14 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
EOF
mc ilm import erainfra/erainfra-cache < "$rule"
mc ilm rule ls erainfra/erainfra-cache    # confirm the prefix that landed
```

Two things that rule is doing, both of which matter:

- **`Expiration`** removes entries and their blobs together. Below the configured prefix the layout
  is `<prefix>entries/<owner>/<repo>/<ref>/<version>/<key>` for metadata and
  `<prefix>blobs/<owner>/<repo>/<id>` for bytes, so an age rule on the prefix itself reaches both.
  An entry whose blob has expired is served as a miss, not as an error.
- **`AbortIncompleteMultipartUpload`** is the one people forget. A job that dies mid-save leaves a
  multipart upload holding storage that no listing shows and no expiry rule reaches.

Per-repository policies are possible because the repository is a readable path segment: filter on
`<prefix>entries/<owner>/<repo>/` and `<prefix>blobs/<owner>/<repo>/`, with the same `<prefix>` the
service is configured with.

---

## 5. What it does when things break

The dangerous outage for a cache is not an error, it is silence: a client with no deadline turns a
cache outage into a job that hangs rather than one that misses. Every handler therefore has a
service-side budget, and every store call is bounded by it.

| what broke                                     | budget                                  | what the job sees                                 |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------------------- |
| store slow, hung, or unreachable, on a restore | `ERAINFRA_CACHE_LOOKUP_TIMEOUT` (5s)    | a cache miss — `204` on v1, `{"ok":false}` on v2  |
| store slow or hung, on a reserve               | `ERAINFRA_CACHE_RESERVE_TIMEOUT` (10s)  | the save is refused; the step warns and continues |
| store fails mid-upload                         | `ERAINFRA_CACHE_TRANSFER_TIMEOUT` (30m) | the save fails; the step warns and continues      |
| token missing, forged or expired               | —                                       | `401`, which is deliberately **not** a miss       |
| a fork pull request tries to save              | —                                       | `403`                                             |

A restore never answers `404` and never answers `500`, whatever went wrong. Those shapes are
measured to be expensive: a v1 `404` costs a warning and a lost cache, and a v2 `500` costs five
attempts and about 30 seconds of backoff **per restore step** before the same lost cache. See
[the protocol capture](../research/actions-cache-protocol-capture.md) L121–L128.

A `401` is the one failure that is not disguised as a miss, and that is on purpose: a
misconfigured signing key would otherwise be indistinguishable from a cache that is simply always
cold.

**A cache outage must not make a Worker unready.** The cache is not part of a Profile's capacity
contract. If you find yourself adding a cache check to readiness, re-read ADR 0007's Consequences.

### Reading the logs

```bash
journalctl -u erainfra-cache-service -f
```

| line                                                              | means                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `cache entry saved`                                               | a save completed; carries generation, repository, ref, key, bytes                   |
| `v1 restore degraded to a miss` / `v2 restore degraded to a miss` | the store did not answer in budget — **investigate the store**                      |
| `cache token rejected`                                            | signing key mismatch, or an expired token                                           |
| `refused a cache write to a read-only token`                      | rule 2 working: a fork pull request tried to save                                   |
| `cache key prefix has more entries than one listing page`         | a prefix has grown past one page; "newest wins" may be picking out of a partial set |
| `cache entry metadata contradicts its own location`               | the bucket has been written to by something other than this service                 |

---

## 6. Roll back

Stop the service. Nothing on any Worker changes, because nothing on any Worker was changed: jobs
that were reaching the cache go back to missing, which is slower and not broken.

```bash
systemctl disable --now erainfra-cache-service
```

The bucket keeps its contents. Restarting the service picks them up again — the index is the bucket,
not process state. In-flight uploads are the exception: they are spooled on disk and are dropped on
shutdown, which costs the jobs that were saving a cache miss on their next run.
