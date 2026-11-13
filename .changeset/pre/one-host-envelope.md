---
"@erainfra/backend": patch
"@erainfra/agent": patch
---

The Action Runner Agent's warm-pool capacity check now uses the same CPU and memory envelope as placement, including the whole-host exception: a warm guest that needs all of a Worker's CPUs or memory is measured against the whole host instead of 90%. Before, a Worker sized exactly for its warm pool passed placement but failed the warm-pool check. `testdata/host-envelope-cases.json` owns the rule, and both test suites run its cases.
