---
"@erainfra/backend": patch
"@erainfra/dashboard": patch
---

Remove the pre-Profile webhook job path. The backend no longer stores `workflow_job` deliveries, assigns them to Workers as commands, or asks GitHub to redeliver missed ones; `/github/webhook` acts only on `push`. `agentApi:pendingCommands`, `agentApi:claim` and `agentApi:report` are gone, so a Worker needs Action Runner Agent v0.2.0-rc.20 or later. The `jobs`, `commands`, `runnerDeletions`, `webhookRecovery` and `webhookRecoveryState` tables, the dashboard's Legacy jobs page, and the `ALLOWED_REPOS`, `ALLOW_PUBLIC_REPOS` and `GITHUB_PAT` settings are removed. Reading the `actions/runner` release list now falls back to the controller GitHub App's token instead of `GITHUB_PAT`.
