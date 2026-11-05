# ADR 0010: Name Profiles the way runner vendors name labels

- Status: Accepted
- Date: 2026-11-05
- Owners: EraInfra

## Context

A Profile's name is the `runs-on` value a workflow types, the name of the scale set GitHub holds,
and the instance name of the controller unit that serves it. The two Profiles in service,
`rc-linux-js` and `rc-e2e`, were named before the product was EraInfra. `rc` is the retired
Runner Center name, `linux` says less than the label of any hosted runner does, and `js` names the
toolchain of the first minimal image, which the image is meant to outgrow (it is measured against
`ubuntu-latest` by the conformance job and converges on it).

Every hosted-runner vendor has solved the same naming problem, and they agree on more than they
differ. Their documented label shapes on 2026-11-05:

| Vendor | Example | Shape |
|---|---|---|
| GitHub standard | `ubuntu-24.04`, `ubuntu-24.04-arm` | os, dotted version, arch suffix, x64 implied |
| GitHub larger runners | `ubuntu-24.04-16core` (docs example) | admin-chosen, 1–64 chars of `[A-Za-z0-9._-]` |
| Blacksmith | `blacksmith-4vcpu-ubuntu-2404`, `blacksmith-4vcpu-ubuntu-2404-arm` | vendor, size, os + undotted version, `-arm` |
| BuildJet (closed 2026-03-31) | `buildjet-4vcpu-ubuntu-2204-arm` | same as Blacksmith |
| Ubicloud | `ubicloud-standard-4-arm-ubuntu-2404` | vendor, class, size, arch, os + version |
| Depot | `depot-ubuntu-24.04-arm-4` | vendor, os, dotted version, arch, size |
| WarpBuild | `warp-ubuntu-2404-arm64-4x` | vendor, os + version, arch, size |
| actuated | `actuated-arm64-4cpu-16gb` | vendor, arch, size, memory |

Sources: docs.github.com (github-hosted-runners reference, hosted-runners REST API),
docs.blacksmith.sh/blacksmith-runners/overview, and each vendor's runner documentation.

Three constraints come from GitHub rather than taste. Self-hosted labels are matched
case-insensitively. A scale set answers to exactly one name, so there is no alias such as `-latest`
to add later. And ARC's Helm chart caps `runnerScaleSetName` at 45 characters, the tightest limit
any tool in this space puts on the name.

## Decision

A Profile is named

```
erainfra-<N>vcpu-<os><version>[-arm][-<M>gb][-<flavour>]
```

- **`erainfra-` first.** Every vendor leads with its own name, so a label says whose runner it is
  in a workflow file, a log line and a billing export. It also keeps a Profile from ever colliding
  with a GitHub-hosted label: a self-hosted runner that answers to `ubuntu-latest` makes `runs-on`
  ambiguous.
- **Size, then OS.** The Blacksmith and BuildJet order: the label people compare first is the
  size, and moving between this fleet and Blacksmith is a prefix change.
- **Undotted version.** `ubuntu-2404`, `macos-15`, `windows-2025`. Blacksmith, BuildJet, Ubicloud
  and WarpBuild write it that way; it avoids a `.` that some tools treat as a separator.
- **`-arm` for arm64, nothing for x64.** GitHub's own convention (`ubuntu-24.04-arm`) and
  Blacksmith's.
- **Memory only when it is not 4 GiB per vCPU.** That is GitHub's standard ratio (4 vCPU, 16 GiB)
  and Blacksmith's Ubuntu ratio. A Profile off it says so: `erainfra-4vcpu-ubuntu-2404-8gb`.
- **No toolchain in the name while an OS has one default image.** A flavour suffix appears only
  when a second image exists for the same OS and size, and only on the non-default one. Changing
  what the default image contains is an image repin, never a rename.
- **No `-latest`.** A scale set cannot carry an alias, and a moving OS version is the failure mode
  GitHub itself warns about. A consumer that wants indirection keeps the Profile name in its own
  repository variable (Payable: `ERAINFRA_CI_RUNS_ON`), which makes a later move a one-variable
  change.
- **Canary Profiles say so:** `erainfra-canary-<N>vcpu-<os><version>`, so no production name
  means "test".
- **Lowercase `[a-z0-9-]`, starting with a letter, at most 45 characters.** The longest name this
  scheme produces today, `erainfra-canary-16vcpu-ubuntu-2404-arm-32gb`, is 43.

Machines (Workers and Nodes) are named `<site>-<role><nn>`: a lowercase DNS label, unique and
stable, with nothing secret in it, for example `hk-worker01` or `sg-controller01`. The name is what
the dashboard, the logs and the slot accounting key on, so it applies to new enrolments; renaming
an enrolled machine is an operator decision, not a side effect of this ADR.

The controller enforces the hard rules (character set, length, no GitHub-hosted label) and refuses
to start on a name that breaks them. It logs a warning, and keeps running, for a name that is legal
but does not follow the scheme, because `rc-linux-js` and `rc-e2e` are legal and are in service.

## Consequences

- Today's Profiles map to `erainfra-4vcpu-ubuntu-2404` (from `rc-linux-js`, 4 vCPU / 16 GiB,
  Firecracker, Ubuntu 24.04, x64) and `erainfra-canary-4vcpu-ubuntu-2404` (from `rc-e2e`).
- A Profile cannot be renamed in place: GitHub holds the scale-set name. The move is register,
  canary, switch, retire: a second controller instance serves the new name from the same Workers
  and image, the consumer's canary runs on it, the consumer flips its variable, and only then is the
  old controller stopped and its scale set removed. Both Profiles share the same Worker slots during
  the overlap, so capacity does not double.
- The rest of the old-name residue on machines (`RC_*`, `runner-center-*` units and paths, the `rc`
  command) moves by the expand/migrate/contract sequence in
  [the phase-2 rename runbook](../runbooks/rename-phase-2.md), not by this ADR.
