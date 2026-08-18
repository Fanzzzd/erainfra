# syntax=docker/dockerfile:1.19

FROM docker.io/library/golang:1.25.3-bookworm@sha256:4f43b271f9673eb7bd0cb3a49cc17b08d8d6ee110277e26dbacc93c43a5a7793 AS guest
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY apps/runtime ./apps/runtime
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags='-s -w' \
  -o /out/runner-center-guest ./apps/runtime/cmd/runner-center-guest

FROM docker.io/library/ubuntu:24.04@sha256:561618e2c15bf2397621dd04f96926663a3b5616c189cf7e38db7e82f5c538ea

ARG TARGETARCH
ARG RUNNER_VERSION=2.336.0
ARG NODE_VERSION=22.23.2
ARG PNPM_VERSION=11.21.0
ARG GO_VERSION=1.25.3
ARG GH_VERSION=2.97.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install --yes --no-install-recommends \
    build-essential \
    ca-certificates \
    curl \
    dbus \
    docker.io \
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
# runner-center-guest.service carries the same value for the path that carries
# every job; smoke.sh asserts all four agree.
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
# Newer series do set CONFIG_NF_TABLES, so revisit this together with
# GUEST_KERNEL_SERIES in deploy/provision-firecracker-host.sh -- smoke.sh
# asserts the alternative, so a kernel bump that makes this unnecessary will
# show up there rather than silently.
RUN update-alternatives --set iptables /usr/sbin/iptables-legacy \
  && update-alternatives --set ip6tables /usr/sbin/ip6tables-legacy

RUN getent group docker >/dev/null || groupadd --system docker \
  && useradd --create-home --uid 1001 --gid docker --shell /bin/bash runner \
  && usermod --append --groups sudo runner \
  && printf '%%sudo ALL=(ALL:ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/runner \
  && chmod 0440 /etc/sudoers.d/runner \
  && passwd --lock root

RUN case "$TARGETARCH" in \
      amd64) runner_arch=x64; runner_sha=04cf0be1aff4c3ec3554466c39124ca250e3effd8873bb7e8d68535aa9505d5d ;; \
      arm64) runner_arch=arm64; runner_sha=58b758e420b87093fbd4bfddd368074960053e2f1388f01848c82624b90f27d1 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac \
  && install -d -o runner -g docker /opt/runner /opt/hostedtoolcache \
  && curl --fail --location --retry 5 \
    --output /tmp/actions-runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz" \
  && echo "${runner_sha}  /tmp/actions-runner.tar.gz" | sha256sum --check --strict \
  && tar --extract --gzip --file /tmp/actions-runner.tar.gz --directory /opt/runner \
  && rm /tmp/actions-runner.tar.gz \
  && /opt/runner/bin/installdependencies.sh \
  && chown -R runner:docker /opt/runner /opt/hostedtoolcache

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
    --output /opt/action-cache/pnpm_action-setup/0977fd99725f1db4007ccb2928dbb4e90d06cc86.tar.gz \
    https://api.github.com/repos/pnpm/action-setup/tarball/0977fd99725f1db4007ccb2928dbb4e90d06cc86 \
  && curl --fail --location --retry 5 \
    --output /opt/action-cache/actions_setup-node/e51e5fe84fc33b4c73ebe40526b2694712b5b858.tar.gz \
    https://api.github.com/repos/actions/setup-node/tarball/e51e5fe84fc33b4c73ebe40526b2694712b5b858 \
  && curl --fail --location --retry 5 \
    --output /opt/action-cache/actions_setup-go/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e.tar.gz \
    https://api.github.com/repos/actions/setup-go/tarball/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e \
  && printf '%s  %s\n' \
    cebb825b471e77ce4dd7f1f37ccdfb3ae5b68e78f6f6d2f6e2521c3cfce27e72 \
    /opt/action-cache/actions_checkout/3d3c42e5aac5ba805825da76410c181273ba90b1.tar.gz \
    bbd7997a5a866c067a856d7d4b67c5f77cc4ff125cfba458e01922714017b05f \
    /opt/action-cache/pnpm_action-setup/0977fd99725f1db4007ccb2928dbb4e90d06cc86.tar.gz \
    e38c0daec76eaa37bd045c403e54bb8923209512e094b25caac12b1427cc94fe \
    /opt/action-cache/actions_setup-node/e51e5fe84fc33b4c73ebe40526b2694712b5b858.tar.gz \
    74c28703108155983aa31b9e375058a1e4ad8c19c5b7889dca7d95b1e3b0c4d9 \
    /opt/action-cache/actions_setup-go/b7ad1dad31e06c5925ef5d2fc7ad053ef454303e.tar.gz \
    | sha256sum --check --strict \
  && chmod -R a-w /opt/action-cache

# Populate the exact tool-cache layout actions/setup-node probes. Workflows can
# keep using the official action without downloading Node on every fresh VM.
RUN case "$TARGETARCH" in \
      amd64) node_arch=x64; node_sha=d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307 ;; \
      arm64) node_arch=arm64; node_sha=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8 ;; \
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
  && install -d -o runner -g docker /home/runner/.config/pnpm /runner-cache/pnpm \
  && printf 'storeDir: /runner-cache/pnpm\nverifyStoreIntegrity: true\n' \
    > /home/runner/.config/pnpm/config.yaml \
  && printf 'store-dir=/runner-cache/pnpm\nverify-store-integrity=true\n' \
    > /home/runner/.config/pnpm/rc \
  && chown runner:docker \
    /home/runner/.config/pnpm/config.yaml \
    /home/runner/.config/pnpm/rc \
  && node --version \
  && pnpm --version \
  && chown -R runner:docker /opt/hostedtoolcache

# Go, in the same tool-cache layout as Node above, because this image already
# seeds the actions/setup-go archive and then shipped no Go for it to find. The
# version deliberately tracks go.mod and the builder stage at the top of this
# file, so the Go that compiles runner-center-guest and the Go a workflow gets
# are one version rather than two that drift apart unwatched.
RUN case "$TARGETARCH" in \
      amd64) go_arch=x64; go_dist=amd64; go_sha=0335f314b6e7bfe08c3d0cfaa7c19db961b7b99fb20be62b0a826c992ad14e0f ;; \
      arm64) go_arch=arm64; go_dist=arm64; go_sha=1d42ebc84999b5e2069f5e31b67d6fc5d67308adad3e178d5a2ee2c9ff2001f5 ;; \
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
      amd64) gh_arch=amd64; gh_sha=a2c9b8497e1f85b1ad0dfcb78b5a622e098801b8e461e459e88e1ee12f018112 ;; \
      arm64) gh_arch=arm64; gh_sha=73ea440ecad9c9e284429997ee6f93577bc6f7bc6fba357ef62c53ad8fb641a5 ;; \
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
COPY images/ubuntu-24.04-js/runner-center-guest.service /etc/systemd/system/runner-center-guest.service
COPY images/ubuntu-24.04-js/smoke.sh /usr/local/lib/runner-center/smoke.sh

RUN chmod 0755 /usr/local/bin/runner-center-guest /usr/local/lib/runner-center/smoke.sh \
  && systemctl enable docker.service haveged.service runner-center-guest.service \
  && truncate --size 0 /etc/machine-id \
  && rm -f /var/lib/dbus/machine-id \
  && /usr/local/lib/runner-center/smoke.sh

LABEL org.opencontainers.image.source="https://github.com/Fanzzzd/EraInfra" \
  org.opencontainers.image.description="EraInfra minimal Ubuntu 24.04 JavaScript Firecracker profile" \
  org.opencontainers.image.licenses="Apache-2.0"

STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
