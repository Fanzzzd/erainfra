---
status: accepted
---

# Use runner scale sets with platform-specific ephemeral executors

Runner Center will use GitHub's official Runner Scale Set Client as the source of Job demand, capacity negotiation, and JIT configuration. Convex remains the durable Fleet control plane and dashboard, while a small long-running controller turns scale-set demand into scheduled Attempts. Workers execute those Attempts through one deep executor interface: constrained Docker containers for trusted-only Linux bootstrap, Firecracker microVMs for strong Linux isolation, Tart copy-on-write VMs on macOS, and Hyper-V differencing VMs only after the Windows path passes the same production contract.

Fireactions is adopted as the primary reference and upstream candidate for the Linux Firecracker implementation, not as a second control plane. Its fixed replica pools, organization-scoped GitHub ownership, and default image policy would duplicate or weaken Runner Center's scheduling and multi-platform model. The old `workflow_job` webhook scheduler will be retired after the scale-set path is proven; webhook delivery may remain only for optional metadata that the scale-set messages do not provide. The new Docker Profile executor remains an explicitly trusted-only on-ramp, not a substitute for Firecracker's isolation boundary.

Image Releases are managed independently from executors. A minimal Profile promises only an explicit smoke-tested tool contract. A hosted-compatible Profile must be built from a pinned `actions/runner-images` revision and prove that compatibility before it can use a GitHub-style OS name. Experiments use the same Profile, Image Release, resource admission, and executor path as Jobs, with a TTL and cancellation. The first iteration is deliberately non-interactive; interactive access requires a separate image and audited control channel rather than adding SSH to the CI image.

## Considered options

- **Run Fireactions unchanged:** rejected because it is Linux-only, keeps fixed idle replica pools, has no unified multi-worker control plane, and its current default image is not sufficiently pinned or hardened for untrusted PR jobs.
- **Keep the current webhook plus Docker design:** rejected because GitHub documents webhook delivery as less reliable for larger autoscaling systems, and a shared-kernel container cannot provide the isolation or hosted-image contract the product intends to promise.
- **Adopt Kubernetes and ARC:** rejected for this Fleet because the owned Mac and standalone Linux hosts are not one Kubernetes substrate; ARC remains the preferred adapter if a future Worker pool already runs Kubernetes.

## Consequences

The existing Convex authentication, enrollment, audit state, dashboard, Worker inventory, scheduling policy, and verified Tart work remain valuable. GitHub webhook recovery, repository JIT issuance, Linux container provisioning, and label-as-image coupling become migration code. The scale-set client and Firecracker SDK are Go-native, so the prototype will keep the current cross-platform agent stable while introducing small Go controller/runtime binaries behind authenticated local or HTTP seams; a later consolidation is justified only if those two adapters prove the interface.
