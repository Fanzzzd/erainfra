# Runbook: run an apt mirror for Firecracker guests

Both Linux images delete `/var/lib/apt/lists` after their build, so the first `apt-get` in a job
downloads the package lists again. `playwright install --with-deps` does that on every browser
job, even when every package it wants is already installed. A job that runs apt depends on the
Ubuntu archive answering at that moment. On 2026-11-11 GitHub's hosted runners could not resolve
`azure.archive.ubuntu.com` for hours, and every E2E job that ran apt failed after 14 minutes of
retries. An apt mirror on the Worker's network serves those lists and packages from local disk.

When `RC_APT_MIRROR_URL` is set on a Worker's runtime, each guest, at claim:

1. writes the probe script `/usr/local/libexec/erainfra-apt-proxy`;
2. writes `/etc/apt/apt.conf.d/01erainfra-mirror`, which sets
   `Acquire::http::Proxy-Auto-Detect` to that script.

apt runs the script before it fetches from an `http://` source. The script opens a TCP connection to
the mirror with a 2 second limit. It prints the mirror's URL when the connection succeeds, and
`DIRECT` when it does not.

## What it covers, and what it does not

- **`http://` sources go through the mirror.** The Ubuntu archive and security sources in both
  images are `http://`.
- **`https://` sources go direct.** apt's HTTP proxy setting does not apply to them. Docker's,
  GitHub CLI's, Microsoft's and other third-party repositories that use `https://` still fetch
  from the internet.
- **It fails open per apt run.** apt has no fallback of its own when a proxy fails, which is why
  the guest names a probe instead of the proxy. A mirror that is down costs each apt run one 2
  second probe, then apt fetches directly. A mirror that accepts connections but then stops
  answering mid-download fails that download, the same way a broken archive mirror would. Stop
  the service or unset the variable (§6) if the mirror misbehaves.
- **Integrity does not depend on the mirror.** apt checks every `InRelease` signature against the
  image's keyrings and every package against the hashes those signed files list. A mirror that
  returns altered bytes makes apt refuse them. It cannot make apt install them.

## 1. Decide where it runs

The placement rule is the registry mirror's
([operate-the-registry-mirror.md](operate-the-registry-mirror.md#2-decide-where-it-runs)), for the
same reason. ADR 0002's guest network policy drops guest traffic to the Worker host and to private
ranges unless an operator allows them, and ADR 0015 makes egress a property of the Profile.

- **On another host on the Worker's LAN** (recommended): the registry mirror's host, a NAS or the
  controller host. Allow its address in the egress list.
- **On the Worker itself**: only in its own network namespace with its own routed address, reached
  through the host's FORWARD path as an allowed destination. Never open the policy's drop of guest
  traffic to the host.

Firewall the mirror's port to the Worker networks. Anything that can reach it can make it fetch
from the internet.

## 2. Deploy it

Use Ubuntu's `apt-cacher-ng` package. It comes from the same signed archive the mirror host already
trusts, its security updates arrive with the host's own, and there is no third-party image to pin.

```bash
apt-get install --yes apt-cacher-ng
```

The package runs `apt-cacher-ng.service` on port 3142 and caches under `/var/cache/apt-cacher-ng`.
Put that directory on its own filesystem and size it for the package sets the fleet installs. The
default expiry job, `/etc/cron.daily/apt-cacher-ng`, deletes files no current package list
references.

Check that it answers:

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' http://<mirror-host>:3142/acng-report.html   # 200
```

## 3. Point the Workers at it

On each Worker, in `runner-center-runtime.service`'s environment, set the URL and allow the address:

```bash
RC_APT_MIRROR_URL=http://10.20.0.7:3142      # http only, host[:port], no path
RC_EGRESS_ALLOW=...,10.20.0.7/32             # add the mirror; keep the rest
```

Restart the runtime. It refuses to start on a value that is not `http://host[:port]`: an `https://`
URL, a path, a query or credentials. The host must be a hostname or an IP address, because it is
written into a shell script in the guest. For Profiles with allowlist egress, the runtime adds the
mirror to the allowlist itself, as it does for the cache service and the registry mirror.

The runtime hands the URL to each guest at claim, so warm microVMs that booted before the change pick
it up when they are claimed. No image rebuild is needed.

## 4. Verify

In a job on the Profile:

```bash
apt-config dump | grep Proxy-Auto-Detect      # Acquire::http::Proxy-Auto-Detect "/usr/local/libexec/erainfra-apt-proxy";
/usr/local/libexec/erainfra-apt-proxy         # http://10.20.0.7:3142
sudo apt-get update
```

On the mirror host, `http://<mirror-host>:3142/acng-report.html` counts the hits and misses, and
`/var/cache/apt-cacher-ng` holds the fetched lists. A second job's `apt-get update` is served from
the cache.

## 5. What a job sees when the mirror is down

Nothing fails. The probe prints `DIRECT`, and apt fetches from the archive as it would with no
mirror. The guest journal line `apt mirror not used, apt fetches from its sources` appears only when
the guest could not write the two files at claim.

## 6. Roll back

Unset `RC_APT_MIRROR_URL` and restart the runtime. Guests claimed afterwards write neither file.
Stopping `apt-cacher-ng.service` alone is also safe: every apt run probes, gets no answer, and fetches
directly.
