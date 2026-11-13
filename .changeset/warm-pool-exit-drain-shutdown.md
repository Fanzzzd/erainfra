---
"@erainfra/runtime": patch
---

A job placed while its warm pool replaces a parked guest that exited now waits for the replacement instead of failing. If that replacement also exits before a job claims it, jobs fail until the next readiness check. Lowering `warmPool` below the number of running warm jobs no longer fails new jobs; they cold-boot while the pool drains. A job that reaches the runtime after it began shutting down now fails instead of cold-booting.
