---
"@erainfra/backend": minor
---

A job routed to a Profile that then loses every ready Worker no longer has to wait 24 hours: set `ERAINFRA_STRANDED_JOB_ACTION` to `cancel` or `rerun` on the deployment, and grant the controller's GitHub App Actions: Read and write. The control plane then cancels the run after `ERAINFRA_STRANDED_JOB_AFTER_MINUTES` (default 5) and, for `rerun`, asks GitHub to rerun it once. The controller now reports each job it acquires so the control plane knows the job's workflow run. The default, `wait`, changes nothing.
