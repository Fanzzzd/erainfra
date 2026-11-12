---
"@erainfra/backend": patch
---

The `/runs-on` router answers the fallback when no controller holds the Profile's lease. Before, a Profile whose controller was stopped still routed jobs to a scale set nobody listened on.
