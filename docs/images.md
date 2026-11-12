# Image Releases

An Image Release is the immutable OS image a Profile runs, pinned by `sha256`. This page covers
what the default Linux image contains, how it is built and checked against GitHub's runners, and
how its toolchain pins move.

`images/ubuntu-24.04-full` is the second Linux image, published as
`ghcr.io/fanzzzd/runner-center-ubuntu-24.04-full`. It builds GitHub's complete hosted
`ubuntu-24.04` recipe from `actions/runner-images`. The `erainfra-4vcpu-ubuntu-2404` and
`erainfra-16vcpu-ubuntu-2404` Profiles run it.
[Hosted Ubuntu 24.04 software image](design/hosted-ubuntu-2404-image.md) has its design.

## Publish an Image Release

`images/ubuntu-24.04-js` is the default minimal Linux image, published as
`ghcr.io/fanzzzd/runner-center-ubuntu-24.04-js`. Its `Dockerfile` pins every version below; this
page names the tools, not the versions, so it cannot fall behind a pin bump. It contains:

- Ubuntu 24.04 and systemd;
- actions/runner, checksum verified;
- Node.js 22 (the default `node`) and 24, and Go, in the hosted-toolcache layout, each checksum
  verified, so `setup-node` and `setup-go` resolve them without a download;
- GitHub CLI, checksum verified;
- an official runner action-archive cache seeded with the exact checkout, pnpm, setup-node, and
  setup-go commits used by the workflows;
- pnpm, Git, Docker with the Compose v2 and Buildx plugins, build tools, `libatomic1`, and common archive tools including `zstd`,
  which `actions/cache` shells out to and falls back to gzip without;
- the OpenSSH **client**, `python3`, `pip3`, and `rsync`;
- `LANG=C.UTF-8`, a generated `en_US.UTF-8`, and a `tzdata` database set to `Etc/UTC`, so a named
  zone resolves instead of silently falling back to UTC;
- the small MMDSv2 guest bootstrap;
- a locked root password and no SSH server.

The guest's dockerd runs without the iptables `raw` rules Docker Engine 28 and later add for every
container. Each rule drops packets that reach a container's address through any interface but the
container's own bridge. The pinned guest kernel has no raw table (`CONFIG_IP_NF_RAW` and
`CONFIG_NF_TABLES` are both off), and without one `docker start` fails for every container, so
`docker-raw-table.sh` checks for the table at boot and, when it is missing, starts dockerd with
Docker's `DOCKER_INSECURE_NO_IPTABLES_RAW=1`. The rule protects against other hosts on the same
network segment. The guest's only neighbour is its Worker, which already controls the VM, and the
job network policy drops traffic from other guests. A guest kernel with a raw table gets the rules
back without an image change.

Run the **EraInfra runner images** workflow. It builds both Linux architectures, boots the amd64
build in Firecracker on the guest kernel `deploy/provision-firecracker-host.sh` pins, publishes to
GHCR, emits SBOM/provenance attestations, and reports the immutable manifest digest. The boot test
(`images/ubuntu-24.04-js/boot-test.sh`) starts containers on a user-defined network inside the
guest, the way the runner does for `container:` and `services:` jobs; if it fails, nothing is
published. The boot test also runs on every pull request that touches the image, the runtime or
those pins. Use the full `ghcr.io/...@sha256:...` reference in the controller. The workflow
deliberately does not upload a BuildKit cache to GitHub Actions storage. It also runs every Monday
on `main` without a source change, so the Ubuntu packages `apt-get` installs pick up the archive's
security updates; that build is tagged `weekly-<YYYYMMDD>` and `edge`. A rebuild publishes a new
digest and changes nothing a Profile runs: a Profile moves only when you repin it.

This Profile promises its explicit smoke-tested tools, not complete GitHub-hosted image parity.
See [the image research](research/blacksmith-runner-images.md) for why GitHub's minimal runner
container and hosted `ubuntu-24.04` VM are different products.

Exactly _how_ it differs is measured rather than described. The **environment conformance** workflow
runs one fingerprint script on `ubuntu-latest` and on every Profile declared in
[`.github/conformance/profiles.txt`](../.github/conformance/profiles.txt), then diffs the two and
fails on any difference that is not on [an explicit, commented
allowlist](../.github/conformance/allowlist.txt). The allowlist is the written record of every way
this environment is deliberately not GitHub's, and everything not on it is a bug: a job that reads
a different CPU count from the one it may use, a tool present there and missing here, a scratch
directory mounted `noexec`. It runs daily and on every change to the provisioners, the images or
the readiness code, because those are the three inputs that can move it.

A Profile is declarable only once a Worker serves it on _this_ repository. A scale set is registered
on one repository or organization, so a leg for a Profile nobody serves here does not fail. It
queues until the timeout, and a timeout reads exactly like a runner that died.
`erainfra-4vcpu-ubuntu-2404` is registered on the bielcrystal-labs organization. It is deliberately
not declared for that reason, and is therefore not among what the job proves.

## How pins move

The image and the provisioners pin their toolchain by hand, each as a version plus a SHA-256:
actions/runner (the image, `provision-mac.sh`, `build-image.ps1`, and the Docker executor's
`ghcr.io/actions/actions-runner` image, which is pinned by digest), Node.js, Go, the GitHub CLI,
and the four Actions the image pre-downloads. No package manager owns these, so the
**Toolchain pin bump** workflow moves them. Every Monday it runs `scripts/pinbump`, which checks
each pin against upstream and opens one pull request, on branch `automation/pin-bump`, that moves
every pin with a newer release. Each checksum comes from upstream's own checksum source:

| Pin            | Moves to                                         | Checksum source                                                                                                           |
| -------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| actions/runner | the latest release                               | the release asset digest, which must match the SHA-256 table in the release body                                          |
| Node.js        | the newest LTS patch of the major already pinned | `SHASUMS256.txt`, its signature checked with `gpgv` against [nodejs/release-keys](https://github.com/nodejs/release-keys) |
| Go             | the newest patch of the minor in `go.mod`        | the `sha256` in `go.dev/dl/?mode=json`                                                                                    |
| GitHub CLI     | the latest release                               | `checksums.txt`, which must match the release asset digests                                                               |
| Seeded Actions | the newest release of the major already pinned   | none is published; the source archive is hashed once and the image build refuses any other bytes                          |

A major or minor version move (Node.js 26, Go 1.27, `actions/checkout` v8) is never made
automatically; the pull request lists it as a note. Run the same check by hand with
`go run ./scripts/pinbump` (it needs `gpgv`), or limit it with `-only runner`.

The runner pin has a deadline. GitHub's
[self-hosted runner reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)
says a runner with automatic updates disabled must be updated within 30 days of a new release, and
"If you do not perform a software update within 30 days, the GitHub Actions service will not
queue jobs to your runner." The controller registers every scale set with automatic updates
disabled (`DisableUpdate` in `apps/controller/internal/githubscale`), because a Runner that
updated itself inside a one-job VM would download the update on every job and then throw it away.
So, within 30 days of an actions/runner release, merge the bump pull request, publish the image
and repin each Firecracker Profile to the new digest, deploy the control plane (the Docker
executor's image is in its catalog), and cut an EraInfra release so Workers receive the new
provisioners. The **actions/runner near GitHub's cutoff** alert rule (see
[Alerts](monitoring.md#alerts)) fires five days before a Profile's image misses that deadline.

Dependabot covers everything else weekly, grouped into one pull request per ecosystem and held
for 7 days after a release before it is proposed: Actions used by the workflows, Go modules, the
pnpm workspace, and the Action Runner Agent's own npm lockfile. It skips the four seeded Actions,
which only `scripts/pinbump` can move together with the image.

The bump works fully only with the pin-bump GitHub App. Without it the workflow uses
`GITHUB_TOKEN`, and two things change. GitHub does not start workflows for a pull request that
token opens, so CI runs only after a maintainer closes and reopens the pull request; the pull
request body says so. And that token cannot change files under `.github/workflows`, so the seeded
Actions are left alone.

With the App configured, the workflow mints a one-hour installation token with
`actions/create-github-app-token`, and the App's bot account pushes the branch and opens the pull
request. To set it up for a fork or a new owner:

1. Create a GitHub App under the repository owner (**Settings → Developer settings → GitHub Apps**).
   Name it `EraInfra pin-bump <owner>`, turn off the webhook, and give it these repository
   permissions: Contents read and write, Pull requests read and write, Workflows read and write.
2. Generate a private key, then install the App on this repository only.
3. Save the App's client ID as the repository variable `PIN_BUMP_APP_CLIENT_ID` and the private
   key as the repository secret `PIN_BUMP_APP_PRIVATE_KEY`, under **Settings → Secrets and
   variables → Actions**. Delete the downloaded key file afterwards.

The App needs no renewal. Its key does not expire; rotate it by generating a new one, updating the
secret, and deleting the old key on the App's page.

GitHub pauses scheduled workflows in a public repository after 60 days without activity. If the
Monday pull request stops arriving, re-enable **Toolchain pin bump** under the Actions tab.
