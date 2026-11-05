---
status: accepted
---

# Egress is a property of the Profile, enforced on the host

[ADR 0002](0002-verify-the-job-isolation-boundary.md) made the job network policy code and had
readiness verify it, with an "optional allowlist-only egress mode". That mode was a per-host
setting (`RC_EGRESS_MODE` in `runtime.env`) and took CIDRs only. Nobody could use it for a GitHub
Actions job: GitHub's endpoints are a long, changing list of names behind CDNs, and a host setting
cannot give one Profile on a Worker a different policy from another.

## Decision

**A Profile carries its egress.** `egress` sits on the Profile next to `executor` and `vcpus`, with
three modes: `public`, `audit` and `allowlist`. The controller publishes it from `RC_EGRESS_MODE`,
`RC_EGRESS_PRESETS` and `RC_EGRESS_ALLOW`; the control plane validates and normalizes it before
storing it; the Worker receives it with the Profile and validates it again before enforcing it. A
Profile without the field is public, so existing Profiles need no migration. The control plane and
the runtime validate the same shared cases (`testdata/egress-policy-cases.json`).

**Domains are enforced by DNS on the host.** Each audit or allowlist guest's DNS, to any server, is
redirected by nftables to a resolver in the runtime daemon, which picks a view by the query's source
address. For an allowlist guest it answers only allowed names and, before replying, inserts the
answer's addresses into a per-guest nftables set with a timeout of the record's TTL. The forward
chain admits a restricted guest's new TCP and UDP flows only to set members and to the Profile's
CIDRs; established flows survive TTL expiry. This is the design actuated and StepSecurity
Harden-Runner use, and it is robust to IP churn because the set follows DNS. The `github` preset is
the domain list GitHub documents for self-hosted runner communication, not the meta API's IP ranges:
GitHub's own documentation lists names, and the `actions` ranges in the meta API are thousands of
Azure prefixes that change.

**Endpoints the Worker hands every guest are always allowed.** The cache service (`RC_CACHE_SERVICE_URL`) and the Docker Hub registry mirror (`RC_REGISTRY_MIRROR_URL`) join every audit or allowlist Profile's list, by name or address, so turning on an allowlist never silently cuts a job off from them.

**Records are measured on the host.** The forward chain adds every new flow of an observed guest to
a kernel set, and the allowlist's drop path adds to a second one; the resolver keeps the names. At
teardown the runtime collects both for that guest and returns them with the Attempt's result. No
part of the record comes from inside the guest.

**The rules are static; only set membership changes.** The table verified by readiness carries the
Profile egress rules on every host. They match only addresses the runtime put in the per-guest
sets, so a Worker whose Profiles are all public carries them inert, and readiness keeps comparing
the table rule by rule. Membership is written before the guest's first instruction runs (an
`FcInit` handler after CNI and before `InstanceStart`) and removed at teardown; a guest whose sets
cannot be written does not boot.

**The stricter layer wins.** The host override stays: the effective mode is the stricter of host and
Profile, a host allowlist keeps its own default deny for every guest, and a Profile cannot open a
private or host range unless the operator excepts it too. Readiness evidence reports the effective
mode, the Profile policy it enforced, and a network policy hash covering both; the control plane
admits a Worker for an audit or allowlist Profile only when that evidence names the Profile's
current policy and the `egress-policy` check passed.

## Consequences

Upgrading a Worker changes its table, so the host provisioner has to be re-run with the new runtime,
as for every table change before. A Worker whose resolver cannot start stays ready for public
Profiles and is refused for the others. Two allowed names on one shared CDN address admit each
other's traffic; closing that needs SNI inspection, which this does not do. DNS over HTTPS evades
the name record in audit mode, though not the flow record.

## Considered and rejected

- **Expanding the github preset from GitHub's meta API into CIDRs.** Rejected: thousands of
  prefixes, a fetch the Worker would need at readiness time, and ranges that cover far more than
  GitHub.
- **A per-Profile CNI network and subnet.** Rejected: it multiplies conflists, address pools and
  reclaim paths per Profile to express what one set membership expresses.
- **Inspecting SNI with a transparent proxy.** Rejected for now: a userspace proxy in every flow's
  path, TLS 1.3 encrypted ClientHello on the horizon, and the DNS-and-set design already covers the
  documented requirements.
- **Driving nftables over a netlink library.** Rejected: `nft -f -` already applies a batch as one
  transaction, which makes the add, delete, add refresh of an element's timeout atomic, and readiness
  already uses the binary.
