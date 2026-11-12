---
"@erainfra/backend": patch
---

The control plane no longer reads three storage shapes that predate v0.2.0-rc.5: a full benchmark report on the `machines` row, readiness evidence on the `workerReadiness` row, and a JIT config on the `attempts` row. The schema refuses them now. The Worker API is unchanged.
