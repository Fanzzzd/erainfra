---
"@erainfra/backend": patch
---

A scale-set job's start is GitHub's runner assignment time, the clock its finish time is on, and a job is never recorded as finishing before it started. Before, a JobStarted that reached the control plane after the job finished gave it a start later than its finish and a zero duration.
