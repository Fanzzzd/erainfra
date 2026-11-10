# Hosted Ubuntu 24.04 software image

Status: candidate build. No Profile has been repinned.

## Decision

Build the complete Ubuntu 24.04 software recipe from `actions/runner-images`.
Do not substitute a smaller tool list or the ARC runner container.
Package the result as an amd64 OCI image for the existing Firecracker executor.
The Profile keeps its name, `erainfra-4vcpu-ubuntu-2404`, under ADR 0010.
Changing its image digest is a separate operator action.

The Playwright dependencies and rustup from PR #268 are already on main.
The small image remains available. Its publish workflow and deployed digest do not change.

## Upstream source and scope

`images/ubuntu-24.04-full/upstream.json` pins these inputs:

- Commit `add4380b0d6685806e9192c33c37359ee0aa4023`.
- Released image `ubuntu24/20261101.360`, version `20261101.360.1`.
- Toolset `images/ubuntu/toolsets/toolset-2404.json` from that commit.
- Toolset SHA-256 `72d25917a42635cf9be9105f7d6056b6d56ffcdf63ddc24f82fe6cdf526c6c84`.
- Canonical's Ubuntu 24.04 amd64 cloud root filesystem, release `20261017`, by SHA-256.

The cloud root filesystem supplies the server packages that Packer's Azure base assumes.
It is not a copy of a hosted runner and contains no hosted job credentials.
Before the first upstream script, the build makes it match Canonical's Azure image of the
same release in two ways. Apt sources point at `azure.archive.ubuntu.com`, which
`configure-apt-sources.sh` then rewrites to a mirror list, as the Apt test requires.
`azure-base-packages.txt` installs the userspace packages that only the Azure manifest lists,
such as `bpftrace`, `chrony`, `cifs-utils`, and `nvme-cli`. It leaves out the Azure kernel,
GRUB, EFI tools, and the Azure agent. The build fails if a kernel or bootloader appears.
The build runs all software installers, including Android, browsers, Java, .NET, Swift,
Haskell, databases, cloud command-line tools, PowerShell, Homebrew, tool caches, and Docker's
preloaded images. The software set follows the pinned toolset, including its version patterns.

`recipe.py verify` compares the checked-in list of 72 script invocations with the pinned
Packer template. A changed order or a newly added script fails before installation.
PowerShell scripts run with PowerShell. Homebrew runs as the unprivileged build user,
as its Packer provisioner requires. All other scripts run as root.

## OCI build mechanism

A disposable GitHub-hosted `ubuntu-24.04` runner builds one sparse 96 GiB ext4 filesystem.
`systemd-nspawn` boots that filesystem with a separate network namespace and a running
systemd. Docker runs inside that namespace. Its image cache stays inside the guest filesystem.
The builder does not substitute successful no-op commands for `systemctl`, Docker, or tests.

The filesystem is shut down before packaging. GNU tar preserves owners, links, capabilities,
and device nodes. `recipe.py` writes one gzip-compressed OCI layer, its uncompressed digest,
the image config, and the manifest. The config retains the runtime's runner-version label.
A single layer avoids retaining deleted installer archives in intermediate image layers.

The same ext4 filesystem then boots on the provisioner's pinned Firecracker kernel.
Only the boot-test unit and its BusyBox archive are added after packaging.
The existing container-network test must pass before the candidate is pushed to a separate
`runner-center-ubuntu-24.04-full` repository. No deployed image tag is overwritten.

The build is amd64 only. The target Profile has no `-arm` suffix. A future ARM image must
pin the separate upstream ARM Packer template and toolset rather than emulate this recipe.

## Upstream differences

The checked-in patch applies with `git apply --check`. These are the complete recipe changes:

| Script or Packer step                          | Treatment                                                                                      | Reason                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configure-apt-mock.sh`                        | Replace with a recording wrapper                                                               | Upstream's wrapper always exits 0, and the recipe depends on that: `toolset-2404.json` asks apt for the virtual package `netcat`, which fails. The replacement also exits 0, at the same point in the order, and records every failed apt command. The build fails unless each failure is listed with a reason in `apt-failures.allow`. |
| `configure-environment.sh`                     | Patch three waagent configuration edits                                                        | Firecracker has no Azure resource disk or waagent swap management. No swap file is created.                                                                                                                                                                                                                                             |
| `configure-environment.sh`                     | Remove the GRUB rootflags block                                                                | Firecracker loads a separately pinned kernel directly. Its kernel command line remains the runtime's responsibility. No durability flags are silently changed.                                                                                                                                                                          |
| Packer file provisioners                       | Copy the same helpers, installers, tests, report modules, post-generation scripts, and toolset | The build root uses the same `/imagegeneration` layout.                                                                                                                                                                                                                                                                                 |
| Packer reboot before cleanup                   | Defer the reboot to the final Firecracker test                                                 | Restarting the container would test the builder's kernel again. Software tests run before packaging; the final boot exercises the actual guest kernel.                                                                                                                                                                                  |
| Packer report and full test inline step        | Run report generation and all software test files in the same position                         | From `System.Tests.ps1`, the disk free space, read-ahead, and root mount option blocks are skipped. They assert Azure disks, GRUB, and the host kernel command line. Its other four blocks run. The Firecracker boot test covers guest service startup separately.                                                                      |
| Packer `waagent -deprovision+user` inline step | Replace with explicit account and machine-identity cleanup                                     | No Azure agent exists. The final user is EraInfra's runner.                                                                                                                                                                                                                                                                             |
| Post-generation environment expansion          | Replace last-passwd-entry lookup with explicit `/home/runner` substitution                     | A later package account must not redirect tool variables to another user's home.                                                                                                                                                                                                                                                        |
| Post-generation systemd linger                 | Not applied                                                                                    | The runner is launched by its system service, without a login session. User-session services are not yet a parity claim.                                                                                                                                                                                                                |
| Root filesystem table                          | `/dev/vda` instead of `LABEL=cloudimg-rootfs`                                                  | containerd does not keep the filesystem label when it unpacks the OCI layer.                                                                                                                                                                                                                                                            |

`configure-snap.sh`, `install-docker.sh`, `cleanup.sh`, `configure-system.sh`, and
`post-build-validation.sh` are not skipped. Installer-local tests are not disabled.
The build retains snapd and its refresh hold, but Firecracker's device and kernel limits
still constrain what a snap or Android emulator can do at job time.

## EraInfra integration

The image keeps these interfaces:

- `/usr/local/bin/runner-center-guest` and its existing systemd unit.
- `/opt/runner`, the pinned runner archive, and WorkFolder `/home/runner/work`.
- Runner UID 1001, primary Docker group, and passwordless sudo.
- `libatomic1`, `haveged`, iptables-legacy, and the Docker raw-table boot probe.
- Existing sysctl parity, locale, timezone, nofile, and stack settings.
- `/opt/action-cache`, including all hash-pinned action archives from the small image.
- `erainfra-gocacheprog` and the existing cache and network policy interfaces.

The runner and action archive install blocks are extracted from the small image's Dockerfile.
A changed block layout fails the extraction instead of creating a second drifting pin list.
Upstream's larger action archive cache is copied without overwriting those pinned entries.
The build user is removed. Tool caches and Homebrew are transferred to the runner account.
The runner's home is created from the completed upstream skeleton, including Rust and .NET tools.

Upstream writes tool variables and PATH to `/etc/environment`. The build resolves user-home
references and serializes the tool variables to `/etc/erainfra/runner-environment.json`.
`runner-center-guest` loads that file once before advertising readiness. It accepts only
known tool keys. It rejects unknown keys and malformed values. Missing files keep the small
image's environment. The image's PATH wins; runtime identity, JIT credentials, cache locations,
and cache credentials remain authoritative. The service never inherits arbitrary parent env.

## Build capacity and cost

A probe on the public repository's standard `ubuntu-24.04` runner measured a 145 GiB root disk.
It had 86 GiB free before cleanup and 124 GiB free after removing the build host's Android,
.NET, Haskell, Swift, Java, PowerShell, browser, tool-cache, and cloud SDK directories.
Probe run: `42660416876`. These deletions affect only the disposable hosted builder.
The build requires at least 105 GiB free and stops otherwise.

The working set is one guest filesystem plus one compressed OCI layer. There is no second
Docker image store or exported filesystem copy. The build has a six-hour timeout.
Standard hosted Actions minutes for this public repository have no runner charge.
Registry storage and transfer remain subject to GitHub's package policy and account limits.
No larger runner or paid cloud VM is provisioned.

The build artifact records compressed layer bytes, unpacked tar bytes, per-script timings,
wall-clock build seconds, source revision, upstream patch, tool environment, software report,
and boot console. These values must come from a completed build, not from the 60 GB estimate.

## Supply chain and validation

The root archive is hash-pinned. Git checks out an exact upstream commit. The toolset has an
additional SHA-256 check. EraInfra's runner and seeded archives retain their existing hashes.
Third-party workflow actions are pinned by commit. Extra guest packages use signed Ubuntu apt
repositories, as the small image does.

The upstream commit pins the download recipes, not every resolved artifact. Upstream uses
`latest`, version patterns, live package repositories, and moving manifests. Rebuilding the
same commit can therefore change versions and the image digest. Do not claim bit-for-bit
reproducibility. The software report, dpkg list, timings, source pin, and immutable published
digest identify each build. Validation tests the filesystem that is published; it does not
rebuild a second candidate and assume the two are identical.

Conformance now targets `ubuntu-24.04`, not the moving `ubuntu-latest` label. The latter moved
to 26.04 and stopped being a valid baseline for this Profile. Existing Profile conformance
still measures the deployed digest. It cannot prove this candidate before an approved canary
repin. No allowlist entry is added to hide missing candidate software.

Expected residual differences include the Firecracker kernel, virtual devices, IPv6 policy,
DNS policy, self-hosted runner identity, EraInfra cache helpers, primary Docker group, no swap,
and service-session behavior. Hosted `/etc/environment` also has `XDG_RUNTIME_DIR=/run/user/1001`
and `POWERSHELL_DISTRIBUTION_CHANNEL=GitHub-Actions-Linux`. No public build script writes them.
GitHub's private provisioning adds them. The image omits both: there is no user session behind
the first, and the second labels PowerShell telemetry as GitHub's. Version drift between the pinned upstream recipe and a later
hosted rollout must be shown in the software report rather than called exact version parity.

## Production preparation and repin plan

None of these operator steps has been executed.

1. Review the completed build evidence and candidate digest. Require a passing Firecracker
   boot test and all upstream software tests before calling the build usable.
2. Drain the affected Workers. Preserve the previous Profile digest and configuration.
3. Set containerd's devmapper `base_image_size` to `96GB`, which containerd interprets as
   96 GiB. This PR changes the provisioner default from `24GB` to `96GB`. Existing base
   snapshots and filesystems do not resize. A new candidate digest must be unpacked into a
   new 96 GiB base snapshot after containerd restarts.
4. Plan a 320 GiB data thin-pool with the existing 2 GiB metadata backing. The current 160 GiB
   pool cannot safely hold two roughly 60 GiB full bases and concurrent job writes. Reserve
   compressed content-store space outside the pool too. ubuntu0's SSD root had about 651 GB
   free on 2026-11-10. Measure again before the migration.
5. Do not expect `--file-backed-pool 320` to resize an existing pool. The provisioner explicitly
   refuses that behavior. Use a separate drained storage migration with backed-up metadata,
   or dedicated new devices. Keep the original data and metadata pair together for rollback.
6. Set `ERAINFRA_MIN_POOL_FREE_MIB=16384`, and budget warm slots plus active jobs. With two
   60 GiB bases, eight 16 GiB write budgets and 32 GiB reserve need 280 GiB. More concurrency
   or larger measured bases requires a larger pool or a smaller slot count. The runtime's
   current checks are admission thresholds, not per-job disk quotas.
7. Install the guest environment support through the new image. No Firecracker disk-format
   change is needed. Pre-pull and unpack the immutable digest before enabling warm slots;
   do not put a roughly 20 GB first pull on the 15-minute warm-boot path.
8. Repin only an approved canary Profile. Run conformance against hosted `ubuntu-24.04`, then
   actual setup-node, setup-go, Java, Android, .NET, Rust, browser, Docker, and service jobs.
   Inspect differences before repinning `erainfra-4vcpu-ubuntu-2404` to the same digest.
9. Roll back by restoring the previous digest. Retain its base until the new image has passed
   the canary window. Garbage-collect old bases only after rollback is no longer required.
