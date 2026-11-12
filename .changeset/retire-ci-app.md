---
"@erainfra/backend": patch
"@erainfra/dashboard": patch
---

Retire the dashboard's CI GitHub App. The Manifest flow (`/github/app/new`, `/github/app/callback`), the dashboard panel "Legacy webhook runner migration" and the `githubApp` and `githubAppSetups` tables are removed, and the backend no longer reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_WEBHOOK_SECRET`. `/github/webhook` now verifies every delivery against the deploy App's `ERAINFRA_GH_WEBHOOK_SECRET` only, so a leftover repository webhook signed with `GITHUB_WEBHOOK_SECRET` gets 401. The `actions/runner` release read uses the controller GitHub App's token, else none.
