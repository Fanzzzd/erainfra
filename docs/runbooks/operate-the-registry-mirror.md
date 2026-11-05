# Runbook: run a registry mirror for Firecracker guests

A Firecracker guest starts with an empty Docker image store, so every `services:` container,
`container:` job, `docker run` and `FROM` line pulls from Docker Hub on every job. A pull-through
mirror on the Worker's network serves the second pull of an image from local disk, and keeps the
fleet under Docker Hub's anonymous pull limit.

When `RC_REGISTRY_MIRROR_URL` is set on a Worker's runtime, each guest, at claim:

1. sends `GET <mirror>/v2/` with a 3 second timeout, and stops here if nothing answers;
2. writes the mirror into `/etc/docker/daemon.json` as `registry-mirrors` and runs
   `systemctl reload docker.service` (dockerd reloads `registry-mirrors` on SIGHUP);
3. writes the mirror into the runner's `~/.docker/buildx/buildkitd.default.toml` as a `docker.io`
   mirror, so every buildx builder the job creates pulls base images through it too.

Every step fails open. A mirror that does not answer at claim is skipped and the journal says
`registry mirror not used, pulls go to Docker Hub`. A mirror that fails later is skipped per pull:
dockerd lists mirrors ahead of Docker Hub and moves past any error from a mirror endpoint
(`LookupPullEndpoints` in moby's `daemon/pkg/registry/service.go`, `continueOnError` in
`daemon/internal/distribution/errors.go`), and BuildKit and the containerd image store go through
containerd's resolver, which tries the next host on any error. A mirror that refuses connections
costs nothing. A mirror that stops answering mid-job, without refusing, costs each pull dockerd's
dial timeout before the fallback.

Only Docker Hub is mirrored. dockerd's `registry-mirrors` applies to `docker.io` and nothing else, so
a `ghcr.io` or `quay.io` image still pulls from its own registry.

## 1. Decide what it may cache

**Public images only.** The mirror has no authentication: every job on every Worker that can reach it
reads everything it holds. Give it a Docker Hub credential that can read a private repository and the
first job to pull that image publishes it to every other repository on the fleet. Blacksmith keeps
one image disk per organization for exactly this reason.

So either run it anonymously, or give it a Docker Hub personal access token with the **Public Repo
Read-only** scope. The token raises the pull limit from the anonymous per-IP one to the account's,
and its scope makes a private pull impossible rather than merely unconfigured. Never use a token
with read access to private repositories, and never an organization's shared credential.

## 2. Decide where it runs

The same placement rule as the job cache store (`operate-the-job-cache.md` §1) applies, for the same
reason: ADR 0002's guest network policy drops guest traffic to the Worker host itself and to private
ranges unless an operator allows them.

- **On another host on the Worker's LAN** (recommended): a NAS, the controller host, any always-on
  box. Allow its address in the Profile's egress list.
- **On the Worker itself**: only in its own network namespace with its own routed address, reached
  through the host's FORWARD path as an allowed destination, the way a co-located cache service is.
  Never by holing the policy's drop of guest traffic to the host.

## 3. Deploy it

Distribution (`registry:3`) in proxy mode. Pin the image by digest.

```yaml
# /etc/erainfra-registry-mirror/config.yml
version: 0.1
log:
  level: info
storage:
  filesystem:
    rootdirectory: /var/lib/registry
  # The proxy's expiry scheduler deletes what it no longer caches; it needs
  # delete enabled to do it.
  delete:
    enabled: true
  maintenance:
    uploadpurging:
      enabled: true
      age: 168h
      interval: 24h
      dryrun: false
http:
  addr: :5000
  headers:
    X-Content-Type-Options: [nosniff]
proxy:
  remoteurl: https://registry-1.docker.io
  # Optional, see §1: a Public Repo Read-only token, never one that reads
  # private repositories.
  # username: <docker hub user>
  # password: <public-read-only access token>
  # Content not pulled for this long is deleted (distribution's default).
  ttl: 168h
health:
  storagedriver:
    enabled: true
    interval: 10s
    threshold: 3
```

Distribution has no size quota, so give the storage its own filesystem and size that filesystem to
the fleet's working set of images. When it fills, the mirror's writes fail, dockerd falls back to
Docker Hub, and jobs keep running. Expiry (`ttl`) is what keeps it from filling in steady state.

```ini
# /etc/systemd/system/erainfra-registry-mirror.service
[Unit]
Description=EraInfra registry mirror (Docker Hub pull-through)
After=docker.service
Requires=docker.service

[Service]
ExecStartPre=-/usr/bin/docker rm -f erainfra-registry-mirror
ExecStart=/usr/bin/docker run --rm --name erainfra-registry-mirror \
  -p 5000:5000 \
  -v /srv/erainfra-registry-mirror:/var/lib/registry \
  -v /etc/erainfra-registry-mirror/config.yml:/etc/distribution/config.yml:ro \
  docker.io/library/registry:3.1.2@sha256:d4032d4cc323c1731c707931ecada07a53076eac38e3b61ae57533f170f2c6c3
ExecStop=/usr/bin/docker stop erainfra-registry-mirror
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`/srv/erainfra-registry-mirror` is the mount point of the dedicated filesystem. `registry:3` reads its
configuration from `/etc/distribution/config.yml`.

Expiry is the garbage collection. When a cached blob or manifest reaches `ttl`, the proxy's scheduler
deletes it, blob data included (`OnBlobExpire` in distribution's `registry/proxy/proxyregistry.go`
removes the blob from storage, not only its link). Do not schedule `registry garbage-collect` against
a proxy cache: on 3.1.2 it exits with "Path not found: .../_layers" as soon as one repository holds a
manifest whose layers were never pulled, which a proxy routinely does for the platforms nobody runs.

```bash
systemctl daemon-reload
systemctl enable --now erainfra-registry-mirror.service
curl -fsS -o /dev/null -w '%{http_code}\n' http://<mirror-host>:5000/v2/   # 200
```

A proxy cache rejects pushes (`405 unsupported`), so a job can only make the mirror fetch what Docker
Hub already serves; it cannot plant an image in it.

Plain HTTP is fine on a LAN the guests already trust for the job cache: image content is addressed by
digest and every client verifies the digest of what it pulls. Use `https://` if the path to the
mirror crosses a network you do not control, with a certificate a public CA issued; the guest's
dockerd has no way to trust a private one.

## 4. Point the Workers at it

On each Worker, in `runner-center-runtime.service`'s environment, set the URL and allow the address:

```bash
RC_REGISTRY_MIRROR_URL=http://10.20.0.5:5000      # scheme and host[:port] only, no path
RC_EGRESS_ALLOW=...,10.20.0.5/32                   # add the mirror; keep the rest
```

`RC_EGRESS_ALLOW` is what `provision-firecracker-host.sh --egress-allow` writes; re-running the
provisioner with the mirror added keeps the rendered network policy and the environment in step.
Restart the runtime. It refuses to start on a URL dockerd would reject (no scheme, a path, a query,
or credentials), because a guest would otherwise write that value into `daemon.json`, where dockerd
refuses it at its next restart.

The runtime hands the URL to each guest at claim, so warm microVMs that booted before the change pick
it up when they are claimed. No image rebuild is needed.

## 5. Verify

In a job on the Profile:

```bash
docker info --format '{{json .RegistryConfig.Mirrors}}'    # ["http://10.20.0.5:5000/"]
cat ~/.docker/buildx/buildkitd.default.toml                 # mirrors = ["10.20.0.5:5000"]
docker pull docker.io/library/alpine:3
```

On the mirror host, the repository appears under
`/srv/erainfra-registry-mirror/docker/registry/v2/repositories/library/alpine`, and a second job's
pull of the same image does not reach Docker Hub.

## 6. Roll back

Unset `RC_REGISTRY_MIRROR_URL` and restart the runtime. Guests claimed afterwards write no
`daemon.json` and no mirror entry. Stopping the mirror alone is also safe: guests fall back to Docker
Hub on every pull until it is back.
