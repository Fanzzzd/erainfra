---
"@erainfra/runtime": patch
"@erainfra/backend": patch
"@erainfra/agent": patch
---

A Worker now reports the thin-pool reserve it enforces for each guest as `storage.poolReserveMiB`, and placement uses that value. Before, the control plane hard-coded 8 GiB, so changing `RC_MIN_POOL_FREE_MIB` on a Worker changed its own preflight and warm-pool checks but not placement. A runtime that does not report the field is still placed against 8 GiB. Deploy the control plane before rolling out this runtime: an older control plane rejects readiness that carries the new field.
