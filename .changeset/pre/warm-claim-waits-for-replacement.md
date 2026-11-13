---
"@erainfra/runtime": patch
---

A job placed while its Profile's warm pool boots a replacement guest now waits for that guest. The runtime used to fail the job with `warm pool is unhealthy: warm pool owns N-1 of N microVMs`. A pool that has recorded a real failure still fails the job.
