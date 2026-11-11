# syntax=docker/dockerfile:1.19

FROM docker.io/library/golang:1.27.4-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS guest
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY apps/runtime ./apps/runtime
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' \
  -o /out/runner-center-guest ./apps/runtime/cmd/runner-center-guest
# The Go build cache helper a workflow opts into with GOCACHEPROG. Built here,
# from the same tree and toolchain as the guest daemon whose proxy it talks to.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' \
  -o /out/erainfra-gocacheprog ./apps/runtime/cmd/erainfra-gocacheprog

FROM docker.io/library/ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

ARG TARGETARCH
ARG RUNNER_VERSION=2.338.2
ARG NODE_VERSION=22.23.4
ARG NODE_24_VERSION=24.22.2
ARG PNPM_VERSION=11.21.0
ARG GO_VERSION=1.27.4
ARG GH_VERSION=2.103.3

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    dbus \
    docker.io \
    docker-buildx \
    docker-compose-v2 \
    git \
    git-lfs \
    haveged \
    iproute2 \
    iptables \
    jq \
    kmod \
    libatomic1 \
    libicu74 \
    libssl-dev \
    locales \
    net-tools \
    openssh-client \
    pkg-config \
    python3 \
    python3-pip \
    rsync \
    sudo \
    systemd \
    systemd-sysv \
    tzdata \
    udev \
    unzip \
    wget \
    xz-utils \
    zip \
    zstd \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# The system libraries and fonts `playwright install --with-deps chromium` adds on
# Ubuntu 24.04, which GitHub's hosted image already carries. Without them every
# browser job spent about 80 s in apt (Plany canary 42654036610: 104 s against
# hosted's 24 s for the same step). The browser itself is not installed: each
# repository pins its own Playwright version and downloads the matching build.
# The list is Playwright's own, `ubuntu24.04-x64` chromium plus tools, from
# packages/playwright-core/src/server/registry/nativeDeps.ts at
# microsoft/playwright@ac65100a5ffe1fba641c288d920ed87fd3e2f860 (v1.65.0 era).
RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    fonts-freefont-ttf \
    fonts-ipafont-gothic \
    fonts-liberation \
    fonts-noto-color-emoji \
    fonts-tlwg-loma-otf \
    fonts-unifont \
    fonts-wqy-zenhei \
    libasound2t64 \
    libatk-bridge2.0-0t64 \
    libatk1.0-0t64 \
    libatspi2.0-0t64 \
    libcairo2 \
    libcups2t64 \
    libdbus-1-3 \
    libdrm2 \
    libfontconfig1 \
    libfreetype6 \
    libgbm1 \
    libglib2.0-0t64 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xfonts-cyrillic \
    xfonts-scalable \
    xvfb \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

# Without this the image had no locale and no timezone database at all, so the C
# library fell back to ANSI_X3.4-1968 -- ASCII -- and a named zone did not
# resolve because neither /etc/timezone nor /etc/localtime existed. ubuntu-latest
# measures LANG=C.UTF-8, an en_US.UTF-8 present in `locale -a`, and Etc/UTC. Those
# three values are what this reproduces and nothing more: LC_ALL is left unset
# because it is unset on ubuntu-latest too, and setting it would add a new
# difference wearing a fix's clothes. The zone is written explicitly rather than
# left to tzdata's postinst default, so the value is this file's decision.
#
# LANG is stated in three places because three different things start a job. The
# systemd system manager rebuilds a clean environment for every unit and does not
# hand down PID 1's, so ENV alone never reaches a runner: /etc/locale.conf is what
# that manager imports, /etc/default/locale is what PAM gives a login shell, and
# ENV is what a plain `docker run` or `docker exec` against this image sees.
# The path that carries every job -- runner-center-guest spawning the runner --
# states it a fourth time, in the runnerEnv list the binary builds from nothing;
# an Environment= line on the unit measured as dead exactly there (#110).
# smoke.sh asserts all four agree.
RUN locale-gen en_US.UTF-8 \
  && printf 'LANG=C.UTF-8\n' > /etc/locale.conf \
  && printf 'LANG=C.UTF-8\n' > /etc/default/locale \
  && ln --symbolic --force --no-dereference /usr/share/zoneinfo/Etc/UTC /etc/localtime \
  && printf 'Etc/UTC\n' > /etc/timezone

ENV LANG=C.UTF-8

# Ubuntu 24.04 points iptables at the nft backend, which needs CONFIG_NF_TABLES
# in the *guest* kernel. The kernel series the provisioner pins does not have
# it: firecracker v1.13.0's microvm-kernel-ci-<arch>-6.1.config, which built the
# 6.1.141 guest kernel, carries `# CONFIG_NF_TABLES is not set` while every
# legacy xtables option this needs is compiled in. Left on nft, dockerd dies at
# boot with "Failed to initialize nft: Protocol not supported" and takes the
# runner service with it. This is the guest's own alternative and has no bearing
# on the host's.
#
# The same kernel has no legacy raw table either (`# CONFIG_IP_NF_RAW is not
# set`), which Docker 28 and later need for every container endpoint;
# docker-raw-table.sh, installed below, handles that at boot.
#
# Firecracker's builds after the v1.15 series do set CONFIG_NF_TABLES, so
# revisit this together with GUEST_KERNEL_SERIES in
# deploy/provision-firecracker-host.sh. The images workflow boots this image on
# that pinned kernel (boot-test.sh), so a kernel bump that breaks the choice
# shows up there rather than on a Worker.
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy \
  && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

RUN getent group docker >/dev/null || groupadd --system docker \
  && useradd --create-home --uid 1001 --gid docker --shell /bin/bash runner \
  && usermod --append --groups sudo runner \
  && printf '%%sudo ALL=(ALL:ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner \
  && chmod 0440 /etc/sudoers.d/runner \
  && passwd --lock root

RUN case "$TARGETARCH" in \
      amd64) runner_arch=x64; runner_sha=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40 ;; \
      arm64) runner_arch=arm64; runner_sha=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && install -d -o runner -g docker /opt/runner /opt/hostedtoolcache /home/runner/work \
  && curl --fail --location --retry 5 \
    --output /tmp/actions-runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz" \
  && echo "${runner_sha}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --file /tmp/actions-runner.tar.gz --directory /opt/runner \
  && rm /tmp/actions-runner.tar.gz \
  && /opt/runner/bin/installdependencies.sh \
  && chown -R runner:docker /opt/runner /opt/hostedtoolcache

# Rust the way ubuntu-latest has it: rustup and the stable toolchain under the
# runner's home, CARGO_HOME and RUSTUP_HOME pointing there and ~/.cargo/bin on
# PATH (runner-center-guest's runnerEnv hands jobs the same three). Without it
# dtolnay/rust-toolchain first ran rustup-init and downloaded the whole
# toolchain on every job: 11 s against 3 s hosted in Plany canary 42655403683.
# Minimal profile plus the wasm32 target; an action that wants another channel
# or component adds only that. The installer is pinned by hash; the toolchain
# is whatever `stable` is when the image is built, as on the hosted image, and
# rustup verifies it.
ARG RUSTUP_VERSION=1.29.3
ENV CARGO_HOME=/home/runner/.cargo RUSTUP_HOME=/home/runner/.rustup
RUN case "$TARGETARCH" in \
      amd64) rust_target=x86_64-unknown-linux-gnu; rustup_sha=b1c8cb14e30889e7e2999e6b69e62d9e9b9ffc0f4df8180564d306d9680e6c55 ;; \
      arm64) rust_target=aarch64-unknown-linux-gnu; rustup_sha=9f608c142e0e38a78957d0661ba1dfaf0b6fb37184cfaa4b9a0aa57af6184282 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl --fail --location --retry 5 --output /tmp/rustup-init \
    "https://static.rust-lang.org/rustup/archive/${RUSTUP_VERSION}/${rust_target}/rustup-init" \
  && echo "${rustup_sha}  /tmp/rustup-init" | sha256sum --check --strict \
  && chmod 0755 /tmp/rustup-init \
  && runuser -u runner -- env HOME=/home/runner CARGO_HOME="$CARGO_HOME" RUSTUP_HOME="$RUSTUP_HOME" \
    /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain stable \
    --target wasm32-unknown-unknown \
  && rm /tmp/rustup-init
ENV PATH=/home/runner/.cargo/bin:$PATH

# The runner has an official read-only action archive cache. Seed the Actions
# used by this product and Payable at their workflow-pinned commits; every
# archive is independently hashed so a changed GitHub source archive fails the
# image build instead of silently changing a ready Profile.
RUN install -d \
      /opt/action-cache/actions_checkout \
      /opt/action-cache/pnpm_action-setup \
      /opt/action-cache/actions_setup-node \
      /opt/action-cache/actions_setup-go \
  && curl --fail --location --retry 5 \
    --output /opt/action-cache/actions_checkout/3d3c42e5aac5ba805825da76410c181273ba90b1.tar.gz \
    https://api.github.com/repos/actions/checkout/tarball/3d3c42e5aac5ba805825da76410c181273ba90b1 \
  && curl --fail --location --retry 5 \
    --output /opt/action-cache/pnpm_action-setup/73e46992e05b19abd31f2f3c20e0e7370d762115.tar.gz \
    https://api.github.com/repos/pnpm/action-setup/tarball/73e46992e05b19abd31f2f3c20e0e7370d762115 \
  && curl --fail --location --retry 5 \
    --output /opt/action-cache/actions_setup-node/949feb2413d6458794dcd2491c4babbbce0c15c1.tar.gz \
    https://api.github.com/repos/actions/setup-node/tarball/949feb2413d6458794dcd2491c4babbbce0c15c1 \
  && curl --fail --location --retry 5 \
    --output /opt/action-cache/actions_setup-go/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e.tar.gz \
    https://api.github.com/repos/actions/setup-go/tarball/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e \
  && printf '%s  %s\n' \
    cebb825b471e77ce4dd7f1f37ccdfb3ae5b68e78f6f6d2f6e2521c3cfce27e72 \
    /opt/action-cache/actions_checkout/3d3c42e5aac5ba805825da76410c181273ba90b1.tar.gz \
    9db1e996f00876d332c63e3235b4760eba86ccf0732e1d176fde36c5cb458688 \
    /opt/action-cache/pnpm_action-setup/73e46992e05b19abd31f2f3c20e0e7370d762115.tar.gz \
    fb9d410de60555a0468c6520684b9f66bddc53f33a2b81c1745cd12a24606aef \
    /opt/action-cache/actions_setup-node/949feb2413d6458794dcd2491c4babbbce0c15c1.tar.gz \
    74c28703108155983aa31b9e375058a1e4ad8c19c5b7889dca7d95b1e3b0c4d9 \
    /opt/action-cache/actions_setup-go/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e.tar.gz \
    | sha256sum --check --strict \
  && chmod -R a-w /opt/action-cache

# Populate the exact tool-cache layout actions/setup-node probes. Workflows can
# keep using the official action without downloading Node on every fresh VM.
#
# pnpm keeps its default store, under the runner's home, exactly as on
# ubuntu-latest. The image used to point it at /runner-cache/pnpm, a
# Profile-local volume that no executor mounts any more (ADR 0002: nothing
# writable survives a job). The override outlived the volume and cost more than
# nothing: actions/cache versions an entry by its path, so a store saved on a
# hosted runner could never be restored here, and every job reinstalled from
# the registry.
RUN case "$TARGETARCH" in \
      amd64) node_arch=x64; node_sha=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce ;; \
      arm64) node_arch=arm64; node_sha=6287aa46b6c375d816e63ae66d024fbbfd70404825aabdfdf898a970871d2f4b ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && node_dir="/opt/hostedtoolcache/node/${NODE_VERSION}/${node_arch}" \
  && install -d -o runner -g docker "$node_dir" \
  && curl --fail --location --retry 5 \
    --output /tmp/node.tar.xz \
    "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  && echo "${node_sha}  /tmp/node.tar.xz" | sha256sum --check --strict \
  && tar --extract --xz --strip-components=1 --file /tmp/node.tar.xz --directory "$node_dir" \
  && rm /tmp/node.tar.xz \
  && touch "/opt/hostedtoolcache/node/${NODE_VERSION}/${node_arch}.complete" \
  && ln -s "$node_dir/bin/node" /usr/local/bin/node \
  && ln -s "$node_dir/bin/npm" /usr/local/bin/npm \
  && ln -s "$node_dir/bin/npx" /usr/local/bin/npx \
  && npm install --global --prefix /usr/local "pnpm@${PNPM_VERSION}" \
  && node --version \
  && pnpm --version \
  && chown -R runner:docker /opt/hostedtoolcache

# A second Node, in the tool cache only. GitHub's hosted image carries several
# Node majors there and setup-node takes an exact version straight from it, so a
# workflow that pins Node 24 -- Payable pins 24.22.1 -- would otherwise download
# about 30 MB from nodejs.org on every fresh VM. It is deliberately not linked
# onto PATH: the default `node` stays the 22 this image was built and smoke-tested
# around, and only a workflow that asks setup-node for 24 sees this one.
RUN case "$TARGETARCH" in \
      amd64) node_arch=x64; node_sha=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75 ;; \
      arm64) node_arch=arm64; node_sha=eb187837a2230d4047161ac0be008584e16b46f726e9c9490ee35dc6b17d9ba8 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && node_dir="/opt/hostedtoolcache/node/${NODE_24_VERSION}/${node_arch}" \
  && install -d -o runner -g docker "$node_dir" \
  && curl --fail --location --retry 5 \
    --output /tmp/node.tar.xz \
    "https://nodejs.org/dist/v${NODE_24_VERSION}/node-v${NODE_24_VERSION}-linux-${node_arch}.tar.xz" \
  && echo "${node_sha}  /tmp/node.tar.xz" | sha256sum --check --strict \
  && tar --extract --xz --strip-components=1 --file /tmp/node.tar.xz --directory "$node_dir" \
  && rm /tmp/node.tar.xz \
  && touch "/opt/hostedtoolcache/node/${NODE_24_VERSION}/${node_arch}.complete" \
  && "$node_dir/bin/node" --version \
  && chown -R runner:docker /opt/hostedtoolcache/node

# Go, in the same tool-cache layout as Node above, because this image already
# seeds the actions/setup-go archive and then shipped no Go for it to find. The
# version deliberately tracks go.mod and the builder stage at the top of this
# file, so the Go that compiles runner-center-guest and the Go a workflow gets
# are one version rather than two that drift apart unwatched.
RUN case "$TARGETARCH" in \
      amd64) go_arch=x64; go_dist=amd64; go_sha=7226736c2339719cda28fbf3a54d71aa63bcefe376e98cef00034268dab24840 ;; \
      arm64) go_arch=arm64; go_dist=arm64; go_sha=3392582988a273a87ab5043ee1b2c9c17a2c3c00580bf9326c47a2e0aaaeac92 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && go_dir="/opt/hostedtoolcache/go/${GO_VERSION}/${go_arch}" \
  && install -d -o runner -g docker "$go_dir" \
  && curl --fail --location --retry 5 \
    --output /tmp/go.tar.gz \
    "https://dl.google.com/go/go${GO_VERSION}.linux-${go_dist}.tar.gz" \
  && echo "${go_sha}  /tmp/go.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --strip-components=1 --file /tmp/go.tar.gz --directory "$go_dir" \
  && rm /tmp/go.tar.gz \
  && touch "/opt/hostedtoolcache/go/${GO_VERSION}/${go_arch}.complete" \
  && ln -s "$go_dir/bin/go" /usr/local/bin/go \
  && ln -s "$go_dir/bin/gofmt" /usr/local/bin/gofmt \
  && go version \
  && chown -R runner:docker /opt/hostedtoolcache/go

# gh is one static binary, so it comes from its release the way the runner
# tarball does: pinned version, per-architecture SHA-256, checked before anything
# is extracted. Only the binary is taken -- the release also carries man pages
# and completions this image has no reader for.
RUN case "$TARGETARCH" in \
      amd64) gh_arch=amd64; gh_sha=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d ;; \
      arm64) gh_arch=arm64; gh_sha=ee32df2323c8847f5fac6cb6b4b69ca75828e9329a8f22f677021f7b3306ce63 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && curl --fail --location --retry 5 \
    --output /tmp/gh.tar.gz \
    "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${gh_arch}.tar.gz" \
  && echo "${gh_sha}  /tmp/gh.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --strip-components=2 --file /tmp/gh.tar.gz \
    --directory /usr/local/bin "gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" \
  && rm /tmp/gh.tar.gz \
  && gh --version

COPY --from=guest /out/runner-center-guest /usr/local/bin/runner-center-guest
COPY --from=guest /out/erainfra-gocacheprog /usr/local/bin/erainfra-gocacheprog
COPY images/ubuntu-24.04-js/runner-center-guest.service /etc/systemd/system/runner-center-guest.service
COPY images/ubuntu-24.04-js/smoke.sh /usr/local/lib/runner-center/smoke.sh
COPY images/ubuntu-24.04-js/sysctl-hosted-parity.conf /etc/sysctl.d/90-runner-center-hosted-parity.conf
COPY images/ubuntu-24.04-js/docker-raw-table.sh /usr/local/lib/runner-center/docker-raw-table.sh
COPY images/ubuntu-24.04-js/docker-raw-table.conf /etc/systemd/system/docker.service.d/10-runner-center-raw-table.conf

RUN chmod 0755 /usr/local/bin/runner-center-guest /usr/local/bin/erainfra-gocacheprog /usr/local/lib/runner-center/smoke.sh \
    /usr/local/lib/runner-center/docker-raw-table.sh \
  && systemctl enable docker.service haveged.service runner-center-guest.service \
  && truncate --size 0 /etc/machine-id \
  && rm -f /var/lib/dbus/machine-id \
  && /usr/local/lib/runner-center/smoke.sh

# dev.erainfra.actions-runner.version is read by the Worker's runtime and
# reported with readiness (firecracker/runnerversion.go). Runners register with
# automatic updates off, and GitHub stops queueing jobs to a runner 30 days
# after the next release, so the control plane alerts on the version before
# that. It follows ARG RUNNER_VERSION, which the pin bump moves.
LABEL org.opencontainers.image.source="https://github.com/Fanzzzd/EraInfra" \
  org.opencontainers.image.description="EraInfra minimal Ubuntu 24.04 JavaScript Firecracker profile" \
  org.opencontainers.image.licenses="Apache-2.0" \
  dev.erainfra.actions-runner.version="${RUNNER_VERSION}"

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
