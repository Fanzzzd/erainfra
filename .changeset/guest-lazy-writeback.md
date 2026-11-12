---
"@erainfra/runtime": minor
---

The guest keeps a job's writes in memory (lazy writeback) and resets the VM without syncing, so a job no longer loads the Worker's shared disk with writes to a snapshot that is deleted after the Attempt.
