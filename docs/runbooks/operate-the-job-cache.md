# Runbook: run the job cache

The job cache is `apps/cache-service`: one standalone Go binary that speaks GitHub's Actions Cache
Service protocol — **both generations** — and keeps the bytes in a bucket you point it at. Jobs
reach it as an authenticated network client and nothing writable is added to any Worker, which is
the whole reason [ADR 0007](../adr/0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md)
can add a cache without touching ADR 0002's isolation contract.

**What this runbook covers:** choosing and provisioning the store, running the service, eviction and
the lifecycle rule behind it (§4), the Docker-path variables that offer the endpoint to jobs and the
measurement that showed they cannot reach a cache client (§7), turning on the Firecracker
interceptor, which is how jobs actually reach the service (§8), listing or deleting a
repository's entries (§9), the Turborepo and Go build caches the same service serves (§10), and
the git checkout mirror, which keeps its seeds in it too (§11).

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
needs `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` (eviction, §4), `s3:ListBucket` and the
multipart calls (`s3:AbortMultipartUpload`) on one bucket, and nothing else anywhere.

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

| variable                                   | required | default                        | what it is                                                                            |
| ------------------------------------------ | -------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `ERAINFRA_CACHE_S3_ENDPOINT`               | yes      | —                              | `http(s)://host:port` of the store                                                    |
| `ERAINFRA_CACHE_S3_BUCKET`                 | yes      | —                              | bucket name                                                                           |
| `ERAINFRA_CACHE_S3_ACCESS_KEY`             | yes      | —                              | access key id                                                                         |
| `ERAINFRA_CACHE_S3_SECRET`                 | yes      | —                              | secret key; prefer `ERAINFRA_CACHE_S3_SECRET_FILE`                                    |
| `ERAINFRA_CACHE_S3_REGION`                 | no       | `us-east-1`                    | signing region; R2 wants `auto`                                                       |
| `ERAINFRA_CACHE_S3_PREFIX`                 | no       | `erainfra-cache/v1/`           | key prefix, so one bucket can hold more than the cache                                |
| `ERAINFRA_CACHE_S3_PATH_STYLE`             | no       | `true`                         | address the bucket as a path segment                                                  |
| `ERAINFRA_CACHE_SIGNING_KEY`               | yes      | —                              | HMAC secret shared with the token issuer; ≥32 bytes                                   |
| `ERAINFRA_CACHE_LISTEN`                    | no       | `:8721`                        | listen address                                                                        |
| `ERAINFRA_CACHE_PUBLIC_URL`                | no       | taken from the request         | base URL jobs reach this service at                                                   |
| `ERAINFRA_CACHE_DOWNLOAD_MODE`             | no       | `presign`                      | `presign` or `proxy`; see below                                                       |
| `ERAINFRA_CACHE_DOWNLOAD_TTL`              | no       | `5m`                           | lifetime of a download URL                                                            |
| `ERAINFRA_CACHE_UPLOAD_TTL`                | no       | `1h`                           | lifetime of an upload URL and of a spooled upload                                     |
| `ERAINFRA_CACHE_LOOKUP_TIMEOUT`            | no       | `5s`                           | restore budget; overrun answers a miss                                                |
| `ERAINFRA_CACHE_FACTS_WAIT`                | no       | `45s`                          | how long a request waits for a runner's job facts before a `401`; `0` refuses at once |
| `ERAINFRA_CACHE_RESERVE_TIMEOUT`           | no       | `10s`                          | reserve/finalize budget; overrun refuses the save                                     |
| `ERAINFRA_CACHE_TRANSFER_TIMEOUT`          | no       | `30m`                          | one request body, and the store write it drives                                       |
| `ERAINFRA_CACHE_MAX_ENTRY_BYTES`           | no       | `10737418240` (10 GiB)         | per-entry ceiling                                                                     |
| `ERAINFRA_CACHE_PART_BYTES`                | no       | `33554432` (32 MiB)            | multipart part size                                                                   |
| `ERAINFRA_CACHE_SPOOL_DIR`                 | no       | `$TMPDIR/erainfra-cache-spool` | where in-flight uploads land                                                          |
| `ERAINFRA_CACHE_IDLE_TTL`                  | no       | `7d`                           | evict an entry not restored for this long (§4)                                        |
| `ERAINFRA_CACHE_REPO_QUOTA_BYTES`          | no       | `10737418240` (10 GiB)         | one repository's entries, at most; LRU over it (§4)                                   |
| `ERAINFRA_CACHE_EVICTION_INTERVAL`         | no       | `1h`                           | how often the whole bucket is swept (§4)                                              |
| `ERAINFRA_CACHE_LOG_LEVEL`                 | no       | `info`                         | `debug`, `info`, `warn`, `error`                                                      |
| `ERAINFRA_CACHE_SHARED_BUILD_REPOSITORIES` | no       | empty                          | `owner/name` list whose build caches share the default branch's scope (§10)           |

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

`/metrics` needs no token either and answers in the Prometheus text format. It carries counts only,
with no repository, runner or key in any label. Scrape it from wherever you scrape the rest of the
fleet; §5 lists what to alert on.

---

## 4. Eviction: the service evicts, a lifecycle rule is the backstop

The service applies GitHub's retention rules itself. A bucket lifecycle rule cannot: it expires an
object by the age of its creation, never by when it was last read, and it has no idea what a
repository's entries add up to.

- **Idle.** An entry nobody has restored for `ERAINFRA_CACHE_IDLE_TTL` (7 days) is deleted. An entry
  that was never restored counts from the first sweep that saw it, which for a new entry is within a
  minute of its save (see "Entries no sweep has seen" below).
- **Quota.** When one repository's entries add up to more than `ERAINFRA_CACHE_REPO_QUOTA_BYTES`
  (10 GiB), its least recently used entries are deleted until the total fits. A save that crosses
  the quota is followed by that repository's check within about 30 seconds. Another repository's
  entries never count against it and are never deleted to make room in it.
- **Sweep.** The whole bucket is swept a minute after the service starts and then every
  `ERAINFRA_CACHE_EVICTION_INTERVAL` (1 hour).

Those are GitHub's numbers: 7 days idle and 10 GB per repository. Blacksmith uses the same rules at
25 GB; set `ERAINFRA_CACHE_REPO_QUOTA_BYTES=26843545600` for that.

### How last access is recorded

A restore hit is noted in memory and written within 30 seconds as a small object under
`<prefix>access/`. Its `LastModified` is the entry's last access, so the store's clock decides and
every replica reads the same one. One process rewrites a given entry's marker at most once every 10
minutes, and nothing is written on the request path, so a restore costs the job no extra store round
trip. A crash loses at most the last 30 seconds of restores, which can only make an entry look
older than it is.

### Entries no sweep has seen

An entry with no access marker is never evicted for idleness on its creation time alone. Its
creation time says nothing about whether it is in use: it may have been saved by a version of this
service that recorded no restores at all. The first sweep that sees such an entry writes an adoption
marker beside it (`<prefix>access/<entry>~adopted`) and leaves it alone, and its idle clock starts
then. So an upgrade from a version without eviction deletes nothing for idleness on the first day,
and an entry from before the upgrade that nobody restores goes 7 days after the first sweep.

Adoption protects an entry from idle eviction only. Over quota, an entry that has never been
restored is ordered by its creation time, so the oldest of them goes first.

### What a deletion does, in order

1. A tombstone for the entry's bytes is written under `<prefix>tombstones/`.
2. The entry document is deleted. Every restore from this moment is a miss.
3. The bytes stay for `ERAINFRA_CACHE_DOWNLOAD_TTL` + `ERAINFRA_CACHE_TRANSFER_TIMEOUT` + 5 minutes
   (40 minutes with the defaults). A restore that found the entry just before step 2 holds a
   download URL, and that download completes. The first sweep after that deletes the bytes.

Every restore hit also checks that the entry's bytes exist (one `HEAD`), so an entry whose bytes
went some other way, such as the lifecycle rule below or an operator's own tools, answers a miss
rather than a URL that 404s. The next sweep removes that entry, so the key can be saved again.

Bytes that no entry names, left by a save that never finished, are deleted once they are older than
`ERAINFRA_CACHE_UPLOAD_TTL` + `ERAINFRA_CACHE_TRANSFER_TIMEOUT` + 15 minutes (1 hour 45 minutes with
the defaults). Nothing younger can be deleted, because a v2 save writes its bytes up to one upload
session before it publishes the entry.

The quota is approximate in two bounded ways: a repository can sit over it between a save and the
next 30-second check, and deleted entries' bytes stay in the bucket for the 40-minute grace period.

### More than one replica

Eviction keeps all of its state in the bucket, and every step is safe to repeat: two replicas that
evict the same entry write the same tombstone and delete the same objects. Running it on several
replicas costs duplicate listings; it cannot delete bytes a live entry names. The service as a whole
is still single-replica today for a different reason: a save's v1 reservation or v2 upload session
lives in the memory of the process that opened it, so a save whose requests reach two replicas
fails. Job facts are not a reason. They are kept in the bucket under `<prefix>facts/`, so any
replica can serve any runner (§8, "Job facts survive a restart").

### The credential needs delete

The service now deletes objects, so the bucket credential from §1 needs `s3:DeleteObject` as well.
Without it every sweep fails and logs `cache eviction sweep failed`; restores and saves keep working,
and the bucket grows until the lifecycle rule below catches up.

### Keep a lifecycle rule as the backstop

Keep a rule for the day the service is stopped for a long time or loses its delete permission.
Because a lifecycle rule counts from creation and not from last access, it also removes entries that
are still being restored, so set it well above the idle TTL. **30 days** is the recommendation: a key
restored every day is saved once more each month, which costs one cold run.

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
      "Expiration": { "Days": 30 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
EOF
mc ilm import erainfra/erainfra-cache < "$rule"
mc ilm rule ls erainfra/erainfra-cache    # confirm the prefix that landed
```

Two things that rule is doing:

- **`Expiration`** is the backstop. Below the configured prefix the layout is
  `<prefix>entries/<owner>/<repo>/<ref>/<version>/<key>` for entry documents,
  `<prefix>blobs/<owner>/<repo>/<id>` for bytes, `<prefix>names/<owner>/<repo>` for the GitHub
  repository ID that last saved under each name (§9), and the `access/` and `tombstones/` trees
  above, so an age rule on the prefix reaches all of them. A `names/` record the rule removes is
  written again by the repository's next save. Whatever it removes is safe to remove at any moment:
  an entry whose bytes are gone answers a miss, bytes whose entry is gone are never served, and an
  entry that loses its markers is adopted again by the next sweep, which restarts its idle clock.
- **`AbortIncompleteMultipartUpload`** is not a backstop; it is the only cleanup there is for its
  case. A job that dies mid-save can leave a multipart upload holding storage that no listing shows,
  so the service's sweep cannot see it either.

### Upgrading from a version that did not evict

Nothing to do for the entries already in the bucket: the first sweep adopts them (above). If the
bucket still has the old 14-day lifecycle rule, change it to 30 days, or it will keep removing
entries that are still in use.

---

## 5. What it does when things break

The dangerous outage for a cache is not an error, it is silence: a client with no deadline turns a
cache outage into a job that hangs rather than one that misses. Every handler therefore has a
service-side budget, and every store call is bounded by it.

| what broke                                     | budget                                  | what the job sees                                  |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------- |
| store slow, hung, or unreachable, on a restore | `ERAINFRA_CACHE_LOOKUP_TIMEOUT` (5s)    | a cache miss — `204` on v1, `{"ok":false}` on v2   |
| store slow or hung, on a reserve               | `ERAINFRA_CACHE_RESERVE_TIMEOUT` (10s)  | the save is refused; the step warns and continues  |
| store fails mid-upload                         | `ERAINFRA_CACHE_TRANSFER_TIMEOUT` (30m) | the save fails; the step warns and continues       |
| token missing, forged or expired               | —                                       | `401`, which is deliberately **not** a miss        |
| the job's facts never arrived, or expired      | —                                       | `401` on every cache request of that job           |
| the service restarted while jobs ran           | —                                       | nothing: their facts are read back from the bucket |
| a fork pull request tries to save              | —                                       | `403`                                              |

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

| line                                                              | means                                                                                                            |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `cache entry saved`                                               | a save completed; carries generation, repository, ref, key, bytes                                                |
| `v1 restore degraded to a miss` / `v2 restore degraded to a miss` | the store did not answer in budget — **investigate the store**                                                   |
| `cache token rejected`                                            | signing key mismatch, or an expired token                                                                        |
| `refused a cache write to a read-only token`                      | rule 2 working: a fork pull request tried to save                                                                |
| `cache key prefix has more entries than one listing page`         | a prefix has grown past one page; "newest wins" may be picking out of a partial set                              |
| `cache entry metadata contradicts its own location`               | the bucket has been written to by something other than this service                                              |
| `cache entry evicted`                                             | one deletion; `reason` is `idle`, `quota` or `blob missing`                                                      |
| `cache eviction sweep finished`                                   | the periodic sweep, with counts of what it evicted and deleted                                                   |
| `cache eviction sweep failed`                                     | the store refused a listing or a delete; check `s3:DeleteObject` (§4)                                            |
| `cache entry names a blob that is gone; answering a miss`         | an entry's bytes went outside the service, often the lifecycle rule; swept next                                  |
| `cache entries deleted by an operator`                            | an `admin delete` or `admin clear` (§9)                                                                          |
| `cache admin request rejected`                                    | a bad, stale or replayed admin signature                                                                         |
| `no job facts for runner`                                         | the controller's push for this runner did not land within `ERAINFRA_CACHE_FACTS_WAIT`, or its facts expired (§8) |
| `job facts loaded from the store`                                 | a restarted or second replica picked up a running job's facts from the bucket                                    |
| `job facts could not be loaded from the store`                    | the bucket did not answer the facts read; the request was refused, the next retries                              |
| `job facts not written to the store; ...`                         | a push was answered `503` and the controller retries it; **investigate the store**                               |
| `expired job facts deleted from the store`                        | the eviction sweep removed facts whose job window closed                                                         |
| `build cache lookup degraded to a miss`                           | a Turborepo or Go lookup did not get an answer from the store in budget (§10)                                    |
| `build cache save could not ...`                                  | a Turborepo or Go upload failed at the store; the build carries on (§10)                                         |
| `refused a build cache write to a read-only token`                | rule 2 for build caches: a fork pull request's turbo or Go upload (§10)                                          |
| `refused a save from a repository that gave this name up; ...`    | a job of a renamed-away repository saved after a newer one took the name (§9)                                    |
| `left a newer repository's git seed in place; ...`                | the same, for the git seed's removal of older seeds in its scope (§9)                                            |

### Metrics and the alert worth having

| series                                                       | means                                                                                                                                                                            |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `erainfra_cache_requests_refused_total{reason}`              | requests answered `401`; `reason` is one of the five below                                                                                                                       |
| `erainfra_cache_job_facts_loaded_total`                      | facts read back from the bucket, which is what a restart costs                                                                                                                   |
| `erainfra_cache_job_facts_persist_failures_total`            | pushes answered `503` because the bucket refused the write                                                                                                                       |
| `erainfra_cache_build_requests_total{system,outcome}`        | Turborepo and Go build cache requests (§10); `system` is `turbo` or `go`, `outcome` is `hit`, `miss`, `saved` or `error` (the store failed a lookup, download or upload)         |
| `erainfra_cache_stale_repository_writes_refused_total{kind}` | writes from a job of a repository that gave its name up, refused so the newer holder keeps its entries (§9); `kind` is `save` or `purge` (the git seed's removal of older seeds) |

`reason` is `no_token`, `bad_token` (forged, expired, or a signing key mismatch), `unknown_facts`
(the controller's push for the runner never landed, or the facts expired), `facts_unreadable` (the
bucket did not answer the facts read) or `unscopable`. A refused request is the one cache failure a
job does not report loudly: `actions/cache` warns and carries on, so its restores miss and its saves
are skipped without a red step. Alert on it:

```yaml
- alert: ErainfraCacheRequestsRefused
  expr: sum by (reason) (increase(erainfra_cache_requests_refused_total[15m])) > 0
  for: 15m
```

`unknown_facts` is the reason to look at first. Check the controller log for the runner:
`could not publish cache facts` names the error it gave up on.

A store that fails build cache requests reads as a cold cache to the job: its lookups miss and its
uploads print a turbo warning per task. `outcome="error"` separates that from real misses:

```yaml
- alert: ErainfraBuildCacheStoreErrors
  expr: sum by (system) (increase(erainfra_cache_build_requests_total{outcome="error"}[15m])) > 0
  for: 15m
```

The service log names the step that failed: `build cache lookup degraded to a miss`,
`build cache download degraded to a miss` or `build cache save could not ...`.

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

---

## 7. Point jobs at it, and the measurement that comes first

Two variables, on the **Worker's Agent** rather than on this service, and both off by default. A
fleet that sets neither composes exactly the environment it composed before.

| variable                    | what it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `ERAINFRA_CACHE_URL`        | the endpoint a job's cache client is offered                      |
| `ERAINFRA_CACHE_SERVICE_V2` | `true` or `false`; which protocol generation a client should pick |

They are set on `apps/action-runner-agent` — the process that holds `CONVEX_URL` and
`MACHINE_TOKEN` — and reach a job as `ACTIONS_CACHE_URL` and `ACTIONS_CACHE_SERVICE_V2`, written on
the `docker run` command line by `provision-docker.sh` next to `RC_VCPUS`. The operator's spelling
is `ERAINFRA_CACHE_*` and the job's is `ACTIONS_*`, because a Worker's configuration must not be
confusable with the runner's own job-message variables. A malformed value is refused when the Agent
starts, not when the first job runs.

Today this is the Docker executor only. Firecracker, Tart and Hyper-V compose a guest environment
somewhere else entirely, and there is nothing to gain by wiring them until the measurement below
comes back.

**`ACTIONS_RESULTS_URL` and `ACTIONS_RUNTIME_TOKEN` are deliberately not written, and must not be
added.** Probe run `32109974600` round-tripped a real artifact on `rc-e2e` and recorded what an
action step is given: the artifact service lives at the same `ACTIONS_RESULTS_URL` behind the same
`ACTIONS_RUNTIME_TOKEN`. Repointing either to carry cache traffic takes `actions/upload-artifact`
away from every job on that Worker. That is the price of serving the v2 generation from here, and it
is not a price this seam is allowed to pay quietly.

### Do the free measurement first

The same probe run measured something that decides whether any of this works at all: the runner
overwrites all four cache variables from its job message in every **action** step — and every cache
client (`actions/cache`, `actions/setup-node`, `actions/setup-go`) is an action step. A workflow
`env:` block loses. `$GITHUB_ENV` loses. The container environment is the last candidate, and
whether it survives is **unmeasured**, because until now nothing could set it.

So measure before you deploy anything:

```bash
# On the Worker serving the Profile, in the Agent's environment:
ERAINFRA_CACHE_SERVICE_V2=false
```

Restart the Agent and dispatch the probe:

```bash
gh workflow run cache-env-probe.yml -f cache_service_v2=true
```

Read the **T0** line in the job summary.

- `SURVIVED into an action step` — the container environment reaches a cache client. Setting
  `ERAINFRA_CACHE_URL` will now do something, and the rest of this runbook is worth deploying.
- `OVERWRITTEN in an action step` — the runner replaced it, and no Worker-side variable can reach a
  cache client. Nothing in this runbook fixes that; it makes ADR 0007 an amendment rather than an
  implementation, because what would be left is intercepting the runner itself.

The flag alone is the right thing to set for this: GitHub serves both generations, so it moves no
traffic anywhere new and a wrong answer costs nothing. The capitalisation is the tell — the runner
writes `True` and this writes `true`, so the two are never confusable in the report.

---

## 8. Turn on the Firecracker interceptor cache

§7 ends on the outcome that decides everything: the runner overwrites all four cache variables from
its own job message, so no Worker-side variable reaches a cache client. That is the `OVERWRITTEN`
result, and what is left when a variable cannot win is intercepting the runner itself. This section
is that interception, for the Firecracker fleet (ADR 0008, ADR 0009).

A guest that is handed a cache pins GitHub's one cache host in its `/etc/hosts` to an interceptor on
`100.64.0.1:443`, terminates that host's TLS locally against a CA it minted for this boot, and
forwards the cache path to this service carrying a runner-auth bearer; everything else goes straight
to GitHub (ADR 0012 says why the redirect is a name pin and not a packet rule). It works whichever
way the §7 measurement came back, because it never relies on an environment variable surviving into
an action step, and it is a guest mechanism, so it needs nothing in `provision-docker.sh`. A guest
handed no cache runs exactly as one always did — direct to GitHub — so every part of this is inert
until the last piece is set.

### One key, three holders

The HMAC signing key from §2 (`ERAINFRA_CACHE_SIGNING_KEY`, ≥32 bytes) is shared by exactly three
processes, and a mismatch fails closed rather than serving a wrong scope:

| holder             | variable                        | what it signs / verifies                           |
| ------------------ | ------------------------------- | -------------------------------------------------- |
| the cache service  | `ERAINFRA_CACHE_SIGNING_KEY`    | verifies the runner bearer and the controller push |
| the controller     | `RC_CACHE_SIGNING_KEY`(`_FILE`) | signs the facts push                               |
| the Worker runtime | `RC_CACHE_SIGNING_KEY`(`_FILE`) | mints the runner bearer at claim                   |

The repository a warm VM will serve is unknown when it boots, so the bearer names only the runner.
The controller pushes the job's facts to the service at `JobStarted`, and the service scopes the
bearer at request time. This is why the controller needs a URL and the runtime does not push
anything.

The scale-set message is not enough to build those facts. Its workflow ref names the ref of the
workflow file a job came from, and for a reusable workflow called as `owner/repo/.github/workflows/x.yml@main`
that is `main` whatever branch was pushed. So at `JobStarted` the controller reads the workflow run
(`GET /repos/{owner}/{repo}/actions/runs/{run_id}`) and the repository's default branch with its own
GitHub credentials, and applies GitHub's rule for its hosted cache:

| job                                   | writes to             | reads, in order                                              |
| ------------------------------------- | --------------------- | ------------------------------------------------------------ |
| push to a branch, or any branch event | `refs/heads/<branch>` | own branch, default branch                                   |
| push of a tag                         | `refs/tags/<tag>`     | own tag, default branch                                      |
| pull request from the same repository | `refs/pull/<n>/merge` | merge ref, base branch, default branch                       |
| pull request from a fork              | nothing               | base branch if GitHub lists the pull request, default branch |
| GitHub lookup failed or took over 3 s | nothing               | nothing                                                      |

A sibling branch is never on the read list. The lookups run beside `MarkJobStarted`, not before it,
so they never delay a job; a job whose lookup fails gets facts that grant nothing, and its restores
miss. Jobs of one run share one lookup for ten minutes, so a matrix costs GitHub one request.

The controller's credentials need read access to Actions (for the run) and, for a job inside a
reusable workflow, to Contents (to tell a tag from a branch). For a GitHub App that is
`Actions: Read` and `Contents: Read` on the repositories it serves; for a classic PAT, `repo`.
Without `Actions: Read` every job reads cold; without `Contents: Read`, jobs inside reusable
workflows on branch and tag events do. Either way the controller logs
`could not establish the job's cache scope; publishing read-only facts` with GitHub's status code.
A successful push logs `published cache facts` with the ref, base ref, default branch and the
number of attempts it took.

### Job facts survive a restart

The controller pushes a job's facts once, at `JobStarted`, and never again. Two things keep that one
push from being lost:

- The service answers the push `204` only after it has written the facts to the bucket, at
  `<prefix>facts/<runner>`, beside the cache entries. A restarted service, or a second replica,
  reads them back on the runner's first request and logs `job facts loaded from the store`. The
  record keeps the controller's signature and is verified again on every read, so whoever can write
  to the bucket still cannot grant a runner a repository's cache without the signing key. The eviction
  sweep (`ERAINFRA_CACHE_EVICTION_INTERVAL`, hourly by default) deletes records whose job window has
  closed, so `facts/` holds one small object per job started in the last six hours plus one sweep
  interval. No lifecycle rule is needed for it, and the 30-day rule in §4 does
  no harm.
- The controller retries a push the service could not take: a refused connection, a timeout, a
  `5xx` (including the `503` the service sends when the bucket refused the write), `408` or `429`.
  It backs off from one second to 30 seconds and gives up after 15 minutes, which outlasts a
  deploy or a host reboot. It logs `cache facts push failed; retrying` once, and
  `could not publish cache facts; the job's cache requests will be refused` if it gives up. A `401`
  or `400` is not retried, because a wrong signing key or facts the service will never accept do
  not fix themselves.

A controller failover does not matter to either: facts already pushed are in the bucket, and no
controller has to remember them. A job whose `JobStarted` the old leader took but never published
is the one gap left, and it shows up as `unknown_facts`.

### Roll it out, in order

Each step is inert on its own; the cache serves its first byte only once all four line up.

1. **A runtime that mints the bearer.** v0.2.0-rc.9 and later carry it, along with the guest
   redirect and the daemon-wide `RC_CACHE_SERVICE_URL`. A Worker on an older release needs
   `pnpm run deploy:control-plane` for the newer pin and then `rc update` (see
   `deploy-control-plane.md`).

2. **A guest image that carries the redirect.** The redirect ships in the guest image, not in the
   agent archive, so it moves by repinning the Profile — not by the release tag. The image built from
   the redirect merge (`06eb3bb`) is:

   ```text
   ghcr.io/fanzzzd/runner-center-ubuntu-24.04-js@sha256:2d7f1488ee1c4b27c9038bfd00f93cbef026e111517eaf530176e812968b649b
   ```

   Set that as `RC_IMAGE_RELEASE` in the Profile's `.env` and restart the controller, which patches
   the `profiles` row; warm and new microVMs then boot the new guest. Confirm the running image
   afterward — a Profile that silently kept the old digest is the most likely reason the redirect
   never appears.

3. **A runtime pointed at the service.** On each Worker's `runner-center-runtime.service`, set the
   shared key and the service URL, and open egress to the service so the guest network policy does
   not drop it:

   ```bash
   RC_CACHE_SIGNING_KEY_FILE=/etc/runner-center/cache-signing-key   # the §2 key, 0600, root
   RC_CACHE_SERVICE_URL=https://cache.internal:8721                 # reachable from the guest subnet
   RC_EGRESS_ALLOW=...,10.20.0.5/32                                 # the service's address; keep the rest
   ```

   `RC_EGRESS_ALLOW` takes IPv4 CIDRs only; a host name there fails runtime startup. It is needed
   only when the service's address is in a private range, which the guest policy drops by default.
   A Profile on audit or allowlist egress allows the `RC_CACHE_SERVICE_URL` host on its own, by
   name or address, so its list does not need it (see
   [restrict-job-egress](restrict-job-egress.md)).

   The service must sit where a guest job can reach it. A store or service on a Worker's own host is
   dropped by the guest network policy (§1, Case A): reach it over the bridge as a routed
   destination, never by holing the host-input drop. Restart the runtime.

4. **A controller that pushes facts.** Set `RC_CACHE_FACTS_URL` (the same service, its admin path is
   internal to the client) and `RC_CACHE_SIGNING_KEY` on the controller, both together or neither,
   then `deploy:control-plane`. Without the push, every job scopes to nothing and reads a cold cache —
   safe, but pointless. Grant the controller's GitHub App `Actions: Read` and `Contents: Read` first
   (see "One key, three holders"), or every job's lookup fails and reads cold the same way.

### A cache step at the top of a job

GitHub's `JobStarted` scale-set message reaches the controller late: on 2026-11-10 it arrived 7 to
38 seconds after the job had started on its runner, with the controller's long poll open the whole
time. The controller does not wait for it. When it acquires a job it polls the job list of that
job's workflow run (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs`, every 2 seconds for at
most 3 minutes). GitHub names a job's runner there as soon as it assigns the job, and a job's facts
depend only on its run and its runner's name, so the controller publishes them then and logs
`published cache facts early`. The binding comes from GitHub's record, never from the guest.
`JobStarted` publishes the same facts again afterwards, as the fallback.

A request that still arrives before its facts waits up to `ERAINFRA_CACHE_FACTS_WAIT` (45s) on the
service and is answered as soon as the push lands. The service log says
`request waited for job facts` with the time held. A request still without facts when the wait ends
gets the `401` and the `no job facts for runner` line.

The guest build proxy gives the service 30 seconds to answer a turbo read, so a turbo task that
outlasts both paths builds uncached.

### Verify

Dispatch one job that saves and restores a cache. In the service log (§5) a `cache entry saved`
followed by a hit on the next run, both under `blobs/<owner>/<repo>/`, is the whole chain working:
bearer minted, facts pushed, scope resolved, TLS terminated in the guest. In the guest, the runner's
environment carries `NODE_EXTRA_CA_CERTS` pointing at the interceptor's CA, `REQUESTS_CA_BUNDLE`
and `SSL_CERT_FILE` pointing at `/etc/ssl/certs/ca-certificates.crt`, `/etc/sudoers.d/erainfra-cache`
keeps those three across `sudo`, and `/etc/hosts` ends with a line marked
`# erainfra-cache-interceptor`. Their absence means the redirect did not come up and
the job fell back to GitHub, which is a slower success, never a failure. The guest journal
(`journalctl -u runner-center-guest`) says why: `job cache redirect disabled: ...` at claim, or
`job cache redirect withdrawn: ...` if it came down mid-job.

### Docker builds and container jobs

Everything the runner starts on the guest reaches the interceptor with no workflow change. A Docker
container does not: it has its own hosts file and its image does not trust the per-guest CA, so the
guest leaves it talking to GitHub unless it opts in. The guest watches container starts and pins the
cache host inside a container only after reading, inside that container, the CA at a path its
environment hands to a TLS stack (`SSL_CERT_FILE`, `SSL_CERT_DIR`, or `NODE_EXTRA_CA_CERTS`).

A buildx builder, for BuildKit's `type=gha` cache, opts in with one line. The guest writes
`~/.docker/buildx/buildkitd.default.toml` for the runner, which makes buildx copy the CA into every
builder it creates; this line points the builder's Go TLS stack at the copy:

```yaml
- uses: docker/setup-buildx-action@<commit-sha>
  with:
    driver-opts: env.SSL_CERT_DIR=/etc/ssl/certs:/etc/buildkit/certs/results-receiver.actions.githubusercontent.com
- uses: docker/build-push-action@<commit-sha>
  with:
    cache-from: type=gha
    cache-to: type=gha,mode=max
```

The line is harmless off EraInfra: the directory does not exist there, and Go skips it. A workflow
that passes its own `buildkitd-config` or `buildkitd-config-inline` replaces the default file, so it
must add the CA entry itself:

```toml
[registry."results-receiver.actions.githubusercontent.com"]
ca = ["/usr/local/share/ca-certificates/erainfra-cache.crt"]
```

A `container:` job opts in by mounting the CA and naming it for Node, which runs every JavaScript
action inside the container:

```yaml
container:
  image: node:24
  volumes:
    - /usr/local/share/ca-certificates/erainfra-cache.crt:/etc/erainfra/erainfra-cache.crt:ro
  env:
    NODE_EXTRA_CA_CERTS: /etc/erainfra/erainfra-cache.crt
```

Where no cache is configured, or off EraInfra, the CA file does not exist, Docker mounts an empty
directory in its place, and Node prints one "Ignoring extra certs" warning per process and carries
on. Service containers do not call the cache host and are never pinned. A host-network container that
has not opted in starts with a copy of the guest's `/etc/hosts`, pin included; the guest removes the
pin from it within milliseconds of its start. If the guest cannot read or fix a container, it takes
the whole redirect down rather than leave that container failing TLS.

### Roll back

Unset the runtime's `RC_CACHE_SIGNING_KEY_FILE` (or `RC_CACHE_SIGNING_KEY`, whichever step 3 set) and
`RC_CACHE_SERVICE_URL` and restart it. The runtime then
mints no bearer and hands the guest no service URL, the redirect stays inert, and jobs go direct to
GitHub — the same fall-back a failed redirect already takes. Repinning the Profile to the previous
image digest is the same edit as step 2. Nothing on a Worker is destroyed by either.

### The release step that used to block this

Step 1 once had a release-machinery blocker: the cache-service binary stamped the release commit
into itself, so its checksum depended on the commit that had to carry its pin, and no pin could
match. #134 stamps it with the version instead, and v0.2.0-rc.9 was the first release to publish and
pin `erainfra-cache-service-linux-x86_64`. Nothing in the release procedure needs special handling
for it now.

---

## 9. Manage a repository's cache entries

`erainfra-cache-service admin` lists, deletes and clears one repository's entries. The verbs and
flags are Blacksmith's (`blacksmith cache list|delete|clear`) and the JSON field names are GitHub's
(`key`, `version`, `ref`, `size_in_bytes`, `created_at`, `last_accessed_at`), so a script written for
either reads this one. Output is JSON unless you pass `--format table`.

Run it on the cache service's host. It signs each request with the service's signing key, which on
a systemd install is the root-only `/etc/erainfra/cache-signing-key` from §2:

```bash
cache() { sudo erainfra-cache-service admin "$@" --key-file /etc/erainfra/cache-signing-key; }

# What does this repository hold? Most recently used first.
cache list --repo Fanzzzd/erainfra --format table
# Narrow it: by key prefix, by substring, by ref, by version; sort and page.
cache list --repo Fanzzzd/erainfra --prefix node-cache- --ref refs/heads/main \
  --sort-by size --sort-direction desc --per-page 100 --page 2

# Delete one key: every version and every ref, unless narrowed.
cache delete --repo Fanzzzd/erainfra --key "$key" --version "$version"
# Delete every key that starts with a prefix.
cache delete --repo Fanzzzd/erainfra --prefix go-build-
# Delete everything the repository has.
cache clear --repo Fanzzzd/erainfra
```

`delete` and `clear` ask before deleting when stdin is a terminal, and refuse without `--yes` when it
is not, so a script has to say `--yes` to delete anything. Every command names exactly one
repository with `--repo owner/name`; there is no wildcard and no command that reaches across
repositories. `delete` takes exactly one of `--key` and `--prefix`; everything is `clear`.

| flag / variable                     | default                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------- |
| `--url`, `ERAINFRA_CACHE_ADMIN_URL` | `http://127.0.0.1` on the port in `ERAINFRA_CACHE_LISTEN`, else `:8721` |
| `--key-file`                        | `ERAINFRA_CACHE_SIGNING_KEY_FILE`, else `ERAINFRA_CACHE_SIGNING_KEY`    |

Exit codes: `0` done, `1` the service refused or could not be reached (its message is printed), `2`
the command line was wrong and nothing was sent.

Entries record the GitHub repository ID that saved them, and every listed entry shows it as
`repository_id`. A name can belong to two repositories over time: one deleted or renamed away, and
a new one created under the same name. When the entry and the job both carry an ID, a restore never returns an entry another ID saved, and the
new repository's first save removes the earlier ID's entries. `--repository-id n` narrows `list`,
`delete` and `clear` to one ID, for example to see what is left of the old repository before that
first save:

```bash
cache list --repo Fanzzzd/erainfra --repository-id 1001 --format table
```

Entries saved before the service recorded IDs, and saves from a controller too old to send one,
carry no ID. They belong to the first ID that saves under the name after the upgrade, and a job from
a controller that sends no ID still reads by name alone.

A job of the old repository that was already running when the name moved still has facts naming
it, for up to six hours. Its saves do not take the name back. GitHub assigns repository IDs in
increasing order, so for six hours after an ID takes the name, the service refuses saves from a
smaller ID. It also refuses a smaller ID's removal of the holder's git seed. The job sees a skipped
save (`actions/cache` warns, a build tool's upload is answered as already stored), and the log says
`refused a save from a repository that gave this name up`, with both IDs. Each refusal also counts
in `erainfra_cache_stale_repository_writes_refused_total`. After those six hours, a smaller ID can
only be an older repository renamed into the name, and its first save takes the name and removes
the earlier entries as usual. An older repository renamed into a name within six hours of a newer
one taking it cannot save until that window ends.

A deleted entry is a miss on the very next restore. Its bytes leave the bucket on the first sweep
after the 40-minute grace period in §4, so `deleted_bytes` is what the repository's quota stops
counting at once, and the bucket's usage drops within the grace period plus one sweep interval.

### The API under it

Scripts that would rather not shell out can call the API directly; the CLI is a thin client over it.
`GET /_erainfra-cache-admin/entries?repository=owner/name` lists (filters `prefix`, `search`, `ref`,
`version`; `sort`, `direction`, `page`, `per_page` up to 100), and `DELETE` on the same path deletes
(`key` or `prefix` or `all=true`, narrowed by `version` and `ref`).

Every request is signed under a key derived from the signing key, over its method, path, query, a
Unix timestamp, a random nonce and the SHA-256 of its body, in three headers:
`X-Erainfra-Cache-Admin-Timestamp`, `X-Erainfra-Cache-Admin-Nonce` and
`X-Erainfra-Cache-Admin-Signature`. The service refuses a request whose timestamp is more than five
minutes from its clock, compares the signature in constant time, and refuses a nonce it has already
accepted, so a captured `clear` cannot be replayed to delete what was saved after it. Nonces are
remembered per process; behind a balancer with several replicas, one request could be replayed once
per other replica within the five minutes, and only as the same operation. The exact signing steps
are in `apps/cache-service/internal/adminapi`. A rejected request answers `401` and logs
`cache admin request rejected` with the reason.

---

## 10. Build-system caches: Turborepo and Go

The cache service also serves Turborepo's remote cache and Go's build cache
([ADR 0018](../adr/0018-serve-build-system-caches-through-a-guest-proxy.md)). Nothing extra is
deployed: on a Firecracker Profile where §8 is done, every guest runs a build cache proxy on
`127.0.0.1:7457` and the image carries `erainfra-gocacheprog`.

| build tool | workflow change                                  | what the runner's environment carries                                      |
| ---------- | ------------------------------------------------ | -------------------------------------------------------------------------- |
| `turbo`    | none                                             | `TURBO_API=http://127.0.0.1:7457`, `TURBO_TOKEN`, `TURBO_TEAM`             |
| `go`       | `GOCACHEPROG: erainfra-gocacheprog` in the `env` | `ERAINFRA_BUILD_CACHE_URL=http://127.0.0.1:7457` (read only by the helper) |

`TURBO_TOKEN` is a placeholder, not a credential. The proxy presents the runner bearer itself, the
same one the interceptor presents, so a job can do through it exactly what it can through
`actions/cache`.

The Go helper needs Go 1.24 or later; older toolchains ignore `GOCACHEPROG`. It keeps Go's cache on
local disk under `$GOCACHE/erainfra-gocacheprog`, consults that first, and fetches a miss from the
cache service. It checks every download against its output ID, which cmd/go defines as the SHA-256
of the bytes, so a corrupted entry is a miss and never reaches the compiler. Uploads run behind the
build and finish before the go command exits. Go caches test results through the same protocol, so
with the helper on, a test that passed in an earlier job of the repository with the same inputs is
not run again. Add `-count=1` to a test that depends on a database, the network or the clock.
`setup-go`'s own cache of `GOCACHE` already behaves this way. `ERAINFRA_GOCACHEPROG_VERBOSE=1` prints
one line of hit, miss and upload counts per go command.

```yaml
jobs:
  build:
    runs-on: erainfra-4vcpu-ubuntu-2404
    env:
      GOCACHEPROG: erainfra-gocacheprog
    steps:
      - uses: actions/checkout@<commit-sha>
      - uses: actions/setup-go@<commit-sha>
        with:
          go-version: "1.27"
          cache: false # the helper replaces it
      - run: go test ./...
```

### Scope, quota and eviction

A turbo artifact is an entry with key `turbo/<hash>`, a Go output one with key `go/<action ID>`.
Each version names the build system and the guest's CPU architecture, so an arm64 job never restores
an amd64 job's outputs. Everything else is the same as for `actions/cache` entries:

- the scope rules in "One key, three holders" (§8): a branch reads its own ref, its pull request's
  base and the default branch; a sibling branch is never readable; a fork pull request reads and
  writes nothing;
- the per-repository quota and the idle and LRU eviction in §4, counted together with the
  repository's `actions/cache` entries;
- `admin list` and `admin delete` in §9. `cache delete --repo owner/name --prefix turbo/` clears
  one repository's Turborepo artifacts, `--prefix go/` its Go outputs.

### Sharing build outputs with the default branch

Under the scope rules above, a pull request's turbo and Go outputs stay on `refs/pull/<n>/merge`.
After a squash merge the default branch computes the same hashes and finds nothing, so it rebuilds
every task the pull request already built. A repository listed in
`ERAINFRA_CACHE_SHARED_BUILD_REPOSITORIES` saves its `turbo/` and `go/` entries in the default
branch's scope from every job that may write: pushes to any branch and same-repository pull
requests. The default branch then hits on them, and so does every other branch, because the default
branch is on every read list. `actions/cache` entries are unaffected and keep GitHub's per-ref rule.
Fork pull requests still cannot write.

The keys are content hashes of every input, so sharing cannot hand a job another build's output.
What it changes is trust: a pull request's build output becomes something the default branch
consumes. List a repository only when everyone who can open a pull request in it can already push
to its default branch, for example a repository with no branch protection. Remove it when the
default branch gains required reviews or status checks, then clear what it shared with
`cache delete --repo owner/name --prefix turbo/` and `--prefix go/`.

```bash
ERAINFRA_CACHE_SHARED_BUILD_REPOSITORIES=acme/web,acme/api
```

A Go build saves one entry per compiled package, so a repository's entry count grows faster than
its byte count. The quota is in bytes, and listing pages through all of them.

### What jobs see when it breaks

| what broke                                       | `turbo`                                                                | the Go helper                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| cache service unreachable                        | one `Remote caching unavailable` warning, tasks run                    | one `building with the local cache only` line, packages compile |
| the controller's facts for the runner not in yet | the same warning; reads miss, uploads are dropped                      | the same line, naming the `401`                                 |
| store slow or down                               | a miss for that artifact (the service answers `404` within its budget) | a miss for that package                                         |
| the store fails an upload                        | one `failed to contact remote cache ... 503` warning for that task     | one `building with the local cache only` line, naming the `503` |
| a fork pull request uploads                      | nothing printed; the upload is dropped in the guest                    | one `may read the build cache but not write to it` line         |
| a download that does not match its hash          | turbo's own check, if `remoteCache.signature` is on                    | one `discarded` line, and a miss                                |

The proxy writes one line to the guest journal per state change (`journalctl -u runner-center-guest`):
`build cache proxy: the cache service is unreachable ...`, `... answers again`, `... answered 401`,
`... may read the cache but not write to it`, `... could not store a turbo upload`,
`... turbo presented a TURBO_TOKEN the workflow set ...`, and `... refused a request for host ...`
or `... refused a request from a browser`. After an unreachable service it answers locally for 30
seconds before it tries again, so a dead service costs each job one connection timeout, not one per
task.

The proxy answers only requests whose `Host` is `127.0.0.1:7457`, the address in `TURBO_API` and
`ERAINFRA_BUILD_CACHE_URL`, and that carry no `Origin` or `Sec-Fetch-Site` header; anything else
gets a `403`. turbo and the Go helper send neither header. A browser the job runs, such as an
end-to-end test's Chromium, does, so a page that rebinds its DNS name to `127.0.0.1` cannot read
or write the repository's cache through the proxy. A workflow that writes `localhost:7457` into
`TURBO_API` by hand is refused too; use the address the guest sets.

### When it is not used

- **A workflow sets its own `TURBO_API`.** A step's `env` overrides the runner's, so turbo talks to
  that server and the proxy sees nothing.
- **A workflow sets its own `TURBO_TOKEN` but not `TURBO_API`.** turbo still sends to the guest's
  `TURBO_API`, and the request does not say where the workflow meant it to go. The proxy forwards
  that token nowhere, to the cache service or anyone else. turbo's status check gets a `401`, so the
  job log has one `Remote caching unavailable (Authentication failed — check TURBO_TOKEN ...)`
  warning, and the build runs uncached. The guest journal says
  `build cache proxy: turbo presented a TURBO_TOKEN the workflow set ...`. The fix is in the
  workflow's `env`: `TURBO_API: https://vercel.com/api` for Vercel, or the repository's own server.
  Set `TURBO_TEAM` there too, or turbo sends the guest's `erainfra` team. A Profile on allowlist
  egress needs that host on its list.
- **A repository names its own server in `turbo.json` (`remoteCache.apiUrl`) or
  `.turbo/config.json`.** Measured with `turbo config` on turbo 2.10.9, turbo resolves the remote
  cache settings in this order, first wins: the `--api` flag, `TURBO_API` (the step's `env`, else
  the runner's), `.turbo/config.json`, turbo's global config file, then `turbo.json`. The guest's
  `TURBO_API` therefore shadows both files. The guest cannot read them when it sets the runner's
  environment, because the job has not checked anything out yet. Set `TURBO_API` in the workflow
  to the same server; until then the case above applies.
- **`container:` jobs and `docker build`.** A Docker bridge does not reach guest loopback, so turbo
  inside a container prints `Remote caching disabled` and runs its tasks.
- **Opting one workflow out.** `TURBO_CACHE: local:rw` in the `env` turns turbo's remote cache off;
  leaving `GOCACHEPROG` unset leaves Go on its own cache.

### Verify

Run a turbo build twice on the Profile, the second time after any change that does not touch the
packages. The second run's summary says `Cached: N cached, N total`, the service log shows no
`build cache ...` errors, and `erainfra_cache_build_requests_total{system="turbo",outcome="hit"}`
rises. For Go, set `ERAINFRA_GOCACHEPROG_VERBOSE=1` once: the second job's summary line shows remote
hits and few or no misses. `cache list --repo owner/name --prefix turbo/` (§9) shows the artifacts.

### Not served

Bazel's and Buck2's remote caches (REAPI over gRPC, or Bazel's HTTP cache) are not implemented.
Blacksmith serves them; here a Bazel build uses its local disk cache or a remote cache it reaches
over allowed egress.

---

## 11. Git checkout mirror

With `RC_GIT_MIRROR=on` on a Worker, a Firecracker job's checkout of its own repository fetches from
GitHub only the objects the repository's seed lacks. The seed is a git bundle of the repository's
branches and tags that an earlier job saved in this cache service. Workflows keep a stock
`actions/checkout@v4`; nothing in them changes. This is the equivalent of Blacksmith's
`useblacksmith/checkout` and its colocated git proxy, built so that nothing survives on the Worker
(ADR 0002) and the seed is scoped exactly like a cache entry (ADR 0007).

### What it saves

Measured with real git against a local stand-in for GitHub (`apps/runtime/internal/gitmirror`), on a
copy of this repository whose depth-1 checkout is a 2.4 MB pack:

| seed age           | bytes GitHub sends | without the mirror |
| ------------------ | ------------------ | ------------------ |
| 1 commit behind    | 34 KB              | 2.4 MB             |
| 5 commits behind   | 112 KB             | 2.4 MB             |
| 30 commits behind  | 812 KB             | 2.4 MB             |
| 100 commits behind | 1.6 MB             | 2.4 MB             |

What GitHub sends is the objects of the checked-out tree that the seed does not have, so the saving
depends on how much of the tree changed since the seed, not on the repository's size. A large
repository with small changes saves the most. Seeds are refreshed once a day per ref (below), so an
active default branch stays within a day's changes.

The mirror costs local work: restoring the seed (about 0.2 s for this repository's 3.7 MB bundle,
done while the runner sets the job up), one extra request to GitHub to check the job's credential,
and a local `git upload-pack`. On loopback, where the transfer from GitHub costs nothing, a mirrored
checkout took 0.7 to 0.9 s against 0.4 to 0.6 s without it. It pays off when the transfer from
GitHub takes longer than that difference, which it does for large repositories or a slow uplink.

It does not stop the SYN stalls on ubuntu0's uplink to github.com (#149). Every checkout still
contacts GitHub, because the commit being checked out may be newer than any seed. The guest does
share one connection to github.com across all of git's requests that pass through the proxy, kept
open for up to 90 seconds between them, so a job that runs several git commands opens fewer new
connections. That is a side effect, not a fix.

### How it works

1. At claim, the guest starts a proxy on loopback and includes `/etc/erainfra/git-mirror.gitconfig`
   from `/etc/gitconfig`. That file sets `http.https://github.com/.proxy`,
   `http.https://github.com/.sslCAInfo` and `http.https://github.com/.sslCAPath`, so git, and only
   git, sends its `https://github.com/` traffic through the proxy. The proxy terminates TLS for
   github.com with a CA minted for this boot and name-constrained to `github.com` alone. It is a
   second CA, separate from the cache interceptor's. The CA file git is pointed at holds the system
   roots too, so a git that bypasses the proxy still verifies the real github.com. The CA directory
   (`/etc/erainfra/git-mirror-ca.d`) holds the per-guest CA alone. A job that sets `GIT_SSL_CAINFO`
   replaces the CA file but not the directory, so its fetches still trust the proxy instead of
   failing TLS.
2. While the runner sets the job up, the guest asks this service for its seed with the runner-auth
   bearer, `GET /_erainfra-git-seed/v1`. The answer names the job's repository, taken from the job
   facts the controller pushed, and carries the newest seed the job may read. The guest imports it
   into a bare mirror on its own disk.
3. When the job's git fetches its own repository, the proxy checks the job's credential with GitHub
   (a ref advertisement request, or the one the client made a moment earlier), then has the mirror
   fetch the wanted commit from GitHub at the client's depth. GitHub sends only what the mirror lacks.
   The mirror then answers the client's fetch with `git upload-pack`, so the client receives the
   same objects and shallow boundary GitHub would have sent. The workspace has no alternates, no
   extra refs and no borrowed objects; `git fsck` passes and `.git` can be copied into a container.
   Three details keep the answer exactly GitHub's:
   - A fetch with no depth would not ask GitHub for a wanted object the mirror already holds, so
     the proxy asks GitHub for those itself (a fetch that wants each one and claims to have it,
     which GitHub answers with an empty pack). A commit GitHub no longer serves, such as one purged
     after a sensitive-data removal, is refused through the mirror as it is by GitHub.
   - A fetch that follows tags (`include-tag`: a `fetch-depth: 0` checkout, a plain `git fetch`, a
     clone) first brings the mirror's tags in line with GitHub's, so a tag created or deleted since
     the seed is there or gone exactly as on GitHub.
   - The mirror serves one fetch at a time. A fetch that finds it busy, with another fetch or with
     the seed refresh in step 5, goes to GitHub at once rather than wait.
4. Everything else goes to GitHub unchanged: ref listings, pushes, other repositories, LFS, protocol
   v0 clients, and any fetch the mirror cannot answer in full. The mirror reads every line of a
   fetch request and answers only those whose every capability and argument it reproduces exactly:
   `want`, `have`, `shallow`, `done`, `thin-pack`, `ofs-delta`, `no-progress`, `deepen`,
   `deepen-since`, `include-tag` (as above) and the filters `blob:none`, `blob:limit=<n>` and
   `tree:0`. A fetch with anything else goes to GitHub: `deepen-relative` (`git fetch --deepen=<n>`),
   `deepen-not` (`--shallow-exclude`), `want-ref`, any other filter, `packfile-uris`,
   `sideband-all`, `wait-for-done`, `server-option`, an object format other than SHA-1, a
   depth-limited fetch that follows tags (`git clone --depth`), and any line git adds later. The
   guest journal names each kind once: `git mirror: fetches of <repo> that send "<line>" go to
   GitHub directly`.
5. After the job's first fetch of its repository, if the job may write the cache and its seed is
   missing or older than a day, the guest fetches the repository's branches and tags into the mirror
   with the credential that fetch presented, bundles them and saves the bundle with
   `PUT /_erainfra-git-seed/v1`. After the runner exits, the guest waits up to two minutes for a save
   already under way before the VM resets. The job's result is already reported by then.

### Isolation and credentials

- **One repository's seed per job.** The repository comes from the runner's job facts, never from
  the request, so a job can read only its own repository's seed, private repositories included. The
  ref rules are the cache's: a pull request reads its base branch's and the default branch's seeds,
  never a sibling branch's, and a fork's pull request cannot save one.
- **One repository, not one name.** Seeds are keyed by GitHub's repository ID as well as its name,
  from the job facts. A repository deleted, or renamed away, and then created again under the same
  name is a different repository: it never restores the earlier one's seed, and its first save
  removes it. Seeds saved before the controller pushed the ID are not read by jobs whose facts
  carry one, so each repository builds one new seed after the upgrade.
- **GitHub decides who reads.** The mirror answers a fetch only after GitHub has accepted the
  client's credential for that repository within the last minute. A client GitHub refuses gets
  GitHub's refusal, even when the mirror holds every object it asked for.
  `TestMirrorNeverServesAClientGitHubWouldRefuse` and `TestMirrorChecksTheCredentialOnEveryFetch`
  pin this.
- **Only the job's own credential.** The mirror fetches with whatever credential the job's git
  presented: for `actions/checkout`, the job's `GITHUB_TOKEN`, which GitHub scopes to this
  repository and this job. No other GitHub credential enters the guest. The runner-auth bearer goes
  only to this service, never to git or GitHub.
- **A seed cannot plant objects.** Importing a bundle runs `index-pack`, which names every object by
  its content, and checks that every ref's history is complete. A truncated or hostile seed fails to
  import, and the job fetches from GitHub alone. The client receives objects only by the names it
  asked for, so it gets exactly what GitHub would have sent.
- **Other repositories pass through.** A job that clones a second repository, or a submodule from
  another repository, reaches GitHub directly through the proxy. No seed is applied to it or built
  from it.
- **No hole in the host policy.** The guest reaches this service the way the cache interceptor
  does, as an allowed destination (§8, step 3), and GitHub the way the job always did.

### Turn it on

The Worker must already run the Firecracker interceptor cache (§8): the runtime has
`RC_CACHE_SERVICE_URL` and the signing key, and the controller pushes job facts. Then:

1. Deploy a cache service with the seed endpoint (this release or later). An older service answers
   the seed path with a 404 that names no repository, and the guest then leaves every fetch to
   GitHub. Run a controller from the same release too: it pushes the repository ID that seeds are
   keyed by. An older controller pushes none, and its jobs read and save seeds by name alone, as
   before.
2. Repin the Profile to an Image Release whose guest carries the mirror, as in §8 step 2.
3. On each Worker, add the switch to `runner-center-runtime.service`'s environment and restart the
   runtime:

   ```bash
   RC_GIT_MIRROR=on      # also read as ERAINFRA_GIT_MIRROR; on/off, 1/0, true/false
   ```

   The runtime refuses to start with `RC_GIT_MIRROR=on` and no `RC_CACHE_SERVICE_URL`. Warm
   microVMs booted before the change pick it up when they are claimed.

A Profile on `allowlist` egress needs `github.com` allowed, which its checkout needed anyway.

### Verify

In a job on the Profile:

```bash
git config --show-origin --get http.https://github.com/.proxy
# file:/etc/erainfra/git-mirror.gitconfig  http://127.0.0.1:<port>
```

The guest journal (`journalctl -u runner-center-guest`) logs `git mirror: restored <repo>'s seed`
when a seed was found and `git mirror: saved a <n>-byte seed of <repo>` when the job saved one. The
first job of a repository finds no seed and saves one; the second checks out through the mirror.
On this host, the seed shows up as an entry:

```bash
cache list --repo owner/name --prefix erainfra-git-seed/ --format table
```

### What it does not cover

- `container:` jobs and Docker builds that run git inside a container. The container has its own
  git configuration and goes to GitHub directly.
- Checkouts over SSH (`actions/checkout` with `ssh-key`). Only `https://github.com/` is proxied.
- Docker, Tart and Hyper-V Profiles. The mirror is part of the Firecracker guest.
- GitHub Enterprise Server hosts. Only `github.com` is proxied.
- A job that overrides both `GIT_SSL_CAINFO` and `GIT_SSL_CAPATH`, or sets its own
  `http.https://github.com/.sslCAInfo`, no longer trusts the proxy, and its fetches of github.com
  fail TLS. Such a job opts out first (below).
- A purged commit inside the guest. The proxy never serves one, but the seed it was restored from
  is on the guest's disk, and a job with `sudo` can read it. After a sensitive-data removal, delete
  the repository's seeds (below); the next seed is built from GitHub's refs and holds none of the
  purged objects. Seeds refresh daily in any case.

### Costs and limits

A seed is the size of the repository's branches and tags packed, and it counts against the
repository's quota (§4) like any entry. Each ref scope keeps one seed: a new one replaces the older
ones in its scope. A job saves into its own ref's scope, so a pull request whose base branch has no
seed, or only one older than a day, saves one under `refs/pull/<n>/merge` that only that pull
request reads; a daily push to the default branch keeps that from happening. A job that finds no
seed fetches the repository's full branches and tags in the background once, which competes with
the job for the uplink; on a large repository the first job pays that cost so later ones do not.

A seed larger than `ERAINFRA_CACHE_MAX_ENTRY_BYTES` is refused, and the job keeps checking out from
GitHub. The service remembers the refusal under `gitseed-refusals/` in the bucket: one record for
the repository when the refused save came from the default branch, and one per ref otherwise, so a
pull request job that sends an oversized seed holds back only its own ref and never the default
branch. Each record carries the repository ID, so a new repository of the same name starts with
none. The service answers seed lookups covered by a record as not writable for a day, then two, four and at most seven days after each further refusal, so the full background
fetch is not repeated by every job. The guest journal says
`git mirror: the cache service refused <repo>'s last seed as too large; no job builds another
before <time>`, and the service logs `git seed refused` with the size and the limit. Raising
`ERAINFRA_CACHE_MAX_ENTRY_BYTES` above the refused size lifts the backoff at once; the next saved
seed clears the record.

### Opt out, roll back

A job that wants its git to go straight to GitHub for the rest of the job runs
`sudo rm -f /etc/erainfra/git-mirror.gitconfig`; git ignores an include whose file is gone. On the
Worker, unset `RC_GIT_MIRROR` and restart the runtime: guests claimed afterwards write no git
configuration. Delete a repository's seeds with
`cache delete --repo owner/name --prefix erainfra-git-seed/`. A job that finds none checks out from
GitHub and saves a fresh one.

### Designs considered

- **Alternates (`git clone --reference`), as `useblacksmith/checkout` does.** A workspace that
  borrows objects from a mirror breaks when `.git` is copied somewhere the mirror is not, such as a
  Docker build context, which is why Blacksmith offers `dissociate: true`. It also needs the action
  swapped.
- **`fetch.bundleURI`.** Git's own pre-seeding, scoped to the job's repository with
  `includeIf "hasconfig:remote.*.url:..."`. It leaves `refs/bundles/*` and the repository's whole
  history in every workspace, so a depth-1 checkout is no longer depth 1, and it offers no way to
  refresh the seed without a credential the guest does not have.
- **A mirror service on ubuntu0 or another host.** It would have to fetch private repositories
  with a credential of its own, an installation token the controller mints per repository, and keep
  writable state outside the job. Seeding from the job's own fetch needs neither.
- **`url.<mirror>.insteadOf`.** It changes what `git remote get-url origin` prints, which tools such
  as semantic-release and goreleaser parse.
