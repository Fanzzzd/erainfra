---
"@erainfra/runtime": patch
"@erainfra/backend": patch
"@erainfra/agent": patch
---

Placement no longer charges a guest twice for thin-pool space it already wrote. A Worker now reports `storage.poolReserveUsedMiB`: how much of their reserves the guests live at the pool sample had already written, at most one reserve each. Placement admits while `poolFreeMiB + poolReserveUsedMiB >= poolReserveMiB * guests`. Before, a sample taken while guests ran lowered a Worker's disk capacity until its next readiness report, up to 6 hours later for a Profile without a warm pool. A runtime that does not report the field gets no credit, which is the old rule. Deploy the control plane before rolling out this runtime: an older control plane rejects readiness that carries the new field.
