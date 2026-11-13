---
"@erainfra/runtime": patch
"@erainfra/agent": patch
---

A Profile with `warmPool: 0` is ready again. In v0.2.0-rc.22 the runtime's `prepare` printed `"healthy": false` with no detail for every Profile without a warm pool, and the Action Runner Agent marked those Profiles degraded, so they took no jobs. The runtime now reports such a Profile healthy, and a failed `prepare` says why in `detail`. The Agent also accepts the rc.22 output for a target of zero, so a new Agent works with the rc.22 runtime. A warm-pool error the runtime records still fails readiness.
