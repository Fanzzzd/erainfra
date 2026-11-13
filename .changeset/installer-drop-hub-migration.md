---
"@erainfra/backend": patch
---

`/install --role node` no longer migrates a Hub-mode Node. It stops checking for a live `portless-agent.service` or `erainfra-agent.service`, and it refuses `--replace-hub-agent` with a message that says how to stop the old unit by hand. Every Node moved to `connect-convex` before this change.
