---
"@erainfra/runtime": minor
---

A save of a key another job is still uploading is skipped, as GitHub's own cache does. Before, a cold burst of jobs that all missed one key each uploaded the same bytes, and the newest commit won.
