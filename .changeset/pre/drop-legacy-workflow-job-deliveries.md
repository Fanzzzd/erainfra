---
"@erainfra/backend": patch
---

Webhook intake no longer stores a `workflow_job` delivery that the pre-Profile job path would not act on. It answers such a delivery 200 `Ignored`. `/runs-on?labels=` now answers 400 with an error that names `profile=`.
