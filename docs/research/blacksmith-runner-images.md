# Blacksmith runners vs GitHub runner images

Checked on 2026-08-10 against official docs, source, releases, and first-party issue trackers only.

## Bottom line

- If the goal is "behave like GitHub-hosted `ubuntu-24.04`", `ghcr.io/actions/actions-runner` is the wrong baseline. GitHub documents it as a minimal ARC/self-hosted runner container, not the hosted VM image.
- Blacksmith's own docs say Linux/Windows jobs run in ephemeral Firecracker microVMs, and say their Ubuntu runners boot from the same image(s) / same dependencies as GitHub's runner images. That is Blacksmith's compatibility claim, not a GitHub guarantee.
- Blacksmith also describes the implementation: a copy-on-write filesystem per VM, built by Packer plus roughly 50 dependency-installation scripts that mirror GitHub's upstream environment.
- For self-hosted ephemeral runners, the official mature paths are:
  - Kubernetes: ARC.
  - Non-Kubernetes/custom infra: `actions/scaleset`.
  - Need exact GitHub-managed image behavior without self-hosting: GitHub-hosted runners, or larger runners plus GitHub custom images.
- I did not find any official GitHub-published prebuilt self-hosted image that is equivalent to GitHub-hosted `ubuntu-24.04`.
- I also did find matching upstream reports for both classes of failure:
  - minimal `actions-runner` image missing common tools (`git`, `zstd`, etc.);
  - `libatomic.so.1` failures in runner / Node / pnpm on minimal images.

## 1) What Blacksmith says it uses

Blacksmith says:

- Linux and Windows jobs run in "ephemeral Firecracker microVMs" and boot in under 3 seconds:
  - https://docs.blacksmith.sh/blacksmith-runners/overview
- Their runners are orchestrated over a fleet of bare-metal CPUs:
  - https://docs.blacksmith.sh/blacksmith-runners/overview
- They are a "drop-in replacement" because runners "boot off of the same image(s) as GitHub's runners" and have the "exact same environment":
  - https://docs.blacksmith.sh/blacksmith-runners/overview
- For Ubuntu x64 and ARM, they say runners are preinstalled with the same dependencies supported by GitHub's official runner images:
  - https://docs.blacksmith.sh/blacksmith-runners/overview
  - https://github.com/actions/runner-images
- Every VM boots from an isolated copy-on-write filesystem. Blacksmith says it builds that filesystem with Packer and dependency scripts that mirror GitHub's environment, and validates the resulting VM. The article says the image effort covered close to 50 scripts:
  - https://www.blacksmith.sh/blog/how-we-shipped-mac-runners-in-3-weeks

What I could not verify from first-party Blacksmith material:

- Blacksmith does not publish the image builder or the generated root filesystem, so its exact Linux package sync and verification pipeline cannot be audited externally.
- The separately documented Sticky Disk snapshot mechanism uses Ceph, but that is a workflow cache feature, not evidence about where runner root filesystems are stored:
  - https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks

Practical reading:

- "same image(s)" / "same dependencies" is a strong Blacksmith compatibility promise.
- But Blacksmith does not publish, in the pages I found, a pinned `runner-images` commit, a sync SLA, or an exact statement that every hosted-image package/version update lands on the same cadence as GitHub's weekly rollout.

## 2) Why `ghcr.io/actions/actions-runner` is not the same thing as GitHub-hosted `ubuntu-24.04`

GitHub-hosted `ubuntu-24.04`:

- GitHub says standard hosted runners are fresh VMs per job (except `ubuntu-slim`, which is container-based).
  - https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
- GitHub says the VM images and included tools are managed in `actions/runner-images`.
  - https://docs.github.com/en/actions/concepts/runners/github-hosted-runners
  - https://github.com/actions/runner-images
- The `ubuntu-24.04` image README shows a large preinstalled toolchain: `git`, `jq`, `zstd`, Docker, multiple language runtimes, browsers, toolcache, etc.
  - https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md

`ghcr.io/actions/actions-runner`:

- GitHub documents ARC's runner image as a "minimal runner container image".
- GitHub says it contains "the least amount of packages necessary for the container runtime and the runner binaries".
- GitHub says the bundled software is runner binaries, runner container hooks, and Docker.
  - https://docs.github.com/en/actions/concepts/runners/actions-runner-controller
- The Dockerfile confirms the minimal base and package set; it is built from `mcr.microsoft.com/dotnet/runtime-deps:8.0-noble`, sets `ImageOS=ubuntu24`, and installs a small package list plus Docker bits.
  - https://github.com/actions/runner/blob/main/images/Dockerfile

So the official boundary is:

- `runner-images` = GitHub-hosted VM images.
- `actions-runner` package = minimal self-hosted/ARC container image.

GitHub staff/community guidance in the official discussion also says hosted runners are VMs with a lot of bundled software, while self-hosted container runners are expected to be customized by the user:

- https://github.com/actions/runner-images/discussions/7618

## 3) Official and mature paths for self-hosted ephemeral runners

### Official GitHub paths

1. ARC is GitHub's recommended Kubernetes solution.

- GitHub calls ARC the reference implementation of the scale set APIs and the recommended Kubernetes-based autoscaling solution.
  - https://docs.github.com/en/actions/reference/runners/self-hosted-runners

2. `actions/scaleset` is GitHub's official non-Kubernetes building block.

- GitHub documents the Runner Scale Set Client as the official standalone client for building custom autoscaling solutions across VMs, containers, on-prem, and cloud services.
  - https://docs.github.com/en/actions/reference/runners/self-hosted-runners
  - https://github.com/actions/scaleset

3. Ephemeral is the recommended self-hosted runner lifecycle.

- GitHub explicitly recommends ephemeral runners for autoscaling and says persistent autoscaling is not recommended.
  - https://docs.github.com/en/actions/reference/runners/self-hosted-runners

### How to get closest to GitHub-hosted compatibility

Recommended:

1. Build your own VM image from `actions/runner-images` when you need GitHub-hosted parity on self-managed infra.

- GitHub's `runner-images` repo is the source used to create GitHub-hosted VM images.
  - https://github.com/actions/runner-images
- In the official discussion, the guidance is to use the Packer-based image source/workflow from `runner-images` if you want to approximate hosted images yourself.
  - https://github.com/actions/runner-images/discussions/7618

2. Use ARC or `actions/scaleset` only as the control plane, and treat image compatibility as your responsibility.

- ARC's own docs say the default runner image is minimal and you should create your own runner image for extra software.
  - https://docs.github.com/en/actions/concepts/runners/actions-runner-controller

Not recommended:

- Starting from `ghcr.io/actions/actions-runner` and assuming it is equivalent to GitHub-hosted `ubuntu-24.04`.
- Assuming any third-party "runner image" is GitHub-hosted compatible unless it explicitly tracks `actions/runner-images` and you verify the exact tool/version set you need.

### Mature third-party projects I found

These are real, active projects, but none of them are an official GitHub-hosted-image equivalent.

#### GARM

- GARM is an open-source runner manager that creates/scales/destroys ephemeral runners across providers.
  - https://github.com/cloudbase/garm
- Latest stable release I found: `v0.2.0` on 2026-04-26.
  - https://github.com/cloudbase/garm/releases
- GARM's own performance docs say you should pre-install the runner binary in your image to avoid downloading it every boot.
  - https://github.com/cloudbase/garm/blob/main/doc/performance.md

Assessment: mature control plane, but image compatibility remains your job.

#### Fireactions

- Fireactions describes itself as Firecracker-based, ephemeral, and production-ready at `v2.0.0+`.
  - https://github.com/hostinger/fireactions
- Latest release I found: `v2.0.5` on 2026-05-28.
  - https://github.com/hostinger/fireactions/releases
- Its install script points to a default Ubuntu runner image hosted by the project (`ghcr.io/hostinger/fireactions-images/ubuntu22.04:v0.7.0`).
  - https://github.com/hostinger/fireactions/blob/main/install.sh

Assessment: active and directly usable, but it is its own image family, not GitHub-hosted parity.

For Runner Center specifically, the execution implementation is more valuable than the standalone controller:

- It already turns an OCI image into a writable devmapper snapshot, boots it as a Firecracker microVM, injects one JIT configuration over MMDS, and cleans up the VM and GitHub runner:
  - https://github.com/hostinger/fireactions/blob/v2.0.5/server/pool.go
- Pools maintain a fixed desired `replicas` count rather than consuming GitHub scale-set queue statistics. That is simple for a single host, but it duplicates Runner Center's Fleet scheduler and keeps idle VMs registered:
  - https://github.com/hostinger/fireactions/blob/v2.0.5/docs/user-guide/concepts.md
- Installation requires root, KVM, CNI networking, and a dedicated block device used by a hard-coded containerd devmapper snapshotter:
  - https://github.com/hostinger/fireactions/blob/v2.0.5/docs/user-guide/installation.md
  - https://github.com/hostinger/fireactions/blob/v2.0.5/server/pool.go
- The current Ubuntu 24.04 image is a useful medium tool profile, not a hosted-image replica. It uses floating base/package inputs, embeds runner 2.335.1 without checksum verification, and enables password SSH for a fixed root password:
  - https://github.com/hostinger/fireactions-images/blob/main/ubuntu24.04/Dockerfile
- Fireactions lists Hostinger as its only public production adopter:
  - https://github.com/hostinger/fireactions/blob/v2.0.5/ADOPTERS.md

Assessment: use or upstream its Firecracker runtime behind Runner Center's executor interface; do not install the current server and image unchanged as the whole product.

#### Cirun

- Cirun agent is active and uses Meda on Linux and Lume on macOS.
  - https://github.com/cirunlabs/cirun-agent
- Cirun also publishes a prebuilt Docker runner image:
  - https://github.com/cirunlabs/cirun-docker-runner-image
- That image explicitly says it is Ubuntu 24.04 plus bootstrap tooling, with `/opt/hostedtoolcache` pre-created, but the GitHub runner binary is downloaded at job start and is not baked into the image.
  - https://github.com/cirunlabs/cirun-docker-runner-image

Assessment: directly usable prebuilt image exists, but it is not GitHub-hosted `ubuntu-24.04` compatibility.

#### RunsOn runner images for AWS

- RunsOn publishes the source used to replicate official images every 15 days, pins the exact `actions/runner-images` revision, and publishes build provenance:
  - https://github.com/runs-on/runner-images-for-aws
- Its `ubuntu24-full-x64` AMI is described as very close to 1:1 compatible, with deliberate exclusions. It is an AWS AMI, not a portable Docker image or local Firecracker rootfs.

Assessment: the best open reference found for tracking upstream reproducibly, but not directly runnable on the current on-prem host.

#### `catthehacker/ubuntu`

- The active image project provides profile-sized `runner-24.04` / `js-24.04` images and a weekly copied `full-24.04` image. It says the full image is a tar copy of a GitHub Hosted runner and is about 20 GB compressed / 60 GB extracted:
  - https://github.com/catthehacker/docker_images
- Local measurements on the current x64 worker on 2026-08-10:
  - `runner-24.04`: 576,641,345 compressed bytes in the platform manifest and 1,631,108,910 extracted bytes;
  - `js-24.04`: 1,035,215,633 compressed bytes;
  - `full-24.04`: 18,152,754,100 compressed bytes.
- A local red/green reproduction installed `@pnpm/exe@11.7.0` once and ran the same binary in both images. `ghcr.io/actions/actions-runner:2.336.0` failed on missing `libatomic.so.1`; the digest-pinned `runner-24.04` image printed `11.7.0` successfully.

Assessment: useful evidence and a viable profile-image reference, but it is a third-party container supply chain. The medium profiles do not promise hosted-image parity; the full copy is too large to be the default fleet image.

### Direct answer on prebuilts

My recommendation:

- If "trusted, directly usable, 2026 active" means "official GitHub and hosted-image-compatible", I found no such prebuilt.
- If it only means "active open-source project with a published image", Cirun and Fireactions qualify, but neither should be treated as GitHub-hosted image parity.

That last point is an inference from the official sources above: GitHub's official self-hosted image is documented as minimal, while hosted parity is documented through `runner-images` source and hosted VMs.

## 4) Matching upstream failures / original sources

### Missing tools in the official minimal image

- Official docs say ARC's image is minimal:
  - https://docs.github.com/en/actions/concepts/runners/actions-runner-controller
- Upstream bug report: `ghcr.io/actions/actions-runner` missing common tools like `git` and `zstd`, causing `actions/checkout` and `actions/cache` issues.
  - https://github.com/actions/runner/issues/3080

### `libatomic.so.1` on runners / Node / pnpm

- Upstream runner issue: self-hosted runner in Docker failing because bundled Node cannot load `libatomic.so.1`.
  - https://github.com/actions/runner/issues/3030
- Current upstream runner issue list also contains "Node v26 not working in Docker image after installing Node due to missing libatomic".
  - https://github.com/actions/runner/issues
- Upstream Node issue: Node 25+ on Debian/Ubuntu-based images may need `libatomic`.
  - https://github.com/nodejs/node/issues/60790
- Upstream pnpm issue: pnpm 11 standalone binary fails with `libatomic.so.1` missing.
  - https://github.com/pnpm/pnpm/issues/11531
- pnpm installation docs now call this out directly and tell users to install `libatomic1` / `libatomic` on minimal images.
  - https://pnpm.io/installation
- `pnpm/action-setup` now tells users to move pnpm v11+ to `pnpm/setup`, which installs pnpm as a standalone native executable; that makes the pnpm/libatomic note above directly relevant for minimal self-hosted images.
  - https://github.com/pnpm/action-setup
  - https://github.com/pnpm/setup

## Recommendation for this repo

Do not force one image to serve two different promises. Use two explicit tiers:

1. **Production profile now:** a small, digest-pinned Runner Center image based on GitHub's official minimal runner image, with an explicit tested dependency contract (including `libatomic1`). Give it a Runner Center label such as `rc-linux` or `rc-ubuntu-2404-minimal`; do not advertise it as GitHub-hosted-compatible. Pre-pull and smoke-test it before the machine advertises the label.
2. **Hosted-compatible tier later:** a Firecracker microVM backend with copy-on-write VM images built from a pinned `actions/runner-images` revision, following Blacksmith's architecture and RunsOn's upstream-lock/provenance pattern. Only this tier should claim GitHub-hosted parity.

Why this split:

- Shipping the 18 GB compressed community full container as the default makes every image refresh and new worker expensive, still shares the host kernel, and trusts a third-party filesystem copy.
- Reusing a medium community container is reasonable for a prototype, but owning a tiny tested overlay on the official runner image gives a smaller supply chain for the production profile.
- Moving every job to Firecracker immediately would delay the already-working scheduler and macOS path. It should be a separate Linux executor, not an emergency patch for one missing library.

For the hosted-compatible tier:

1. Do not base the compatibility story on `ghcr.io/actions/actions-runner`.
2. Pick an autoscaling control plane separately from the image story:
   - Kubernetes: ARC.
   - Non-Kubernetes: `actions/scaleset`, or a mature third-party controller like GARM / Fireactions if you want more batteries included.
3. Build and pin your own VM image from `actions/runner-images` (or verify a third-party image against the exact tools you require).
4. Add explicit validation for at least `git`, `zstd`, Docker mode, setup actions, and `libatomic1` before calling the image "GitHub-hosted compatible".

If the goal is simply "fast hosted alternative with high compatibility", Blacksmith is plausible on its own documentation, but its Ubuntu compatibility is still ultimately Blacksmith's promise, not GitHub's.
