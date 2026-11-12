---
"@erainfra/backend": minor
---

The `/runs-on` router stores each answer as a `routerDecisions` row with its route and fallback reason, kept 90 days, so routing can be counted per day and repository for billing reconciliation. The router accepts an optional `repo=OWNER/NAME` parameter to tag the row; the answer itself does not change.
