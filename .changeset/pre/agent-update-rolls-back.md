---
"@erainfra/backend": patch
---

`rc update` now checks the new Action Runner Agent's health and rolls back on its own. Before the swap, the installer records which Profiles the control plane sees this Worker ready for (new `GET /agents/readiness`). After the new Agent starts, each of those Profiles must report ready again within `--ready-timeout` seconds (default 900). If one reports degraded or failed, or the deadline passes, the installer restores `agent.previous`, starts it, waits for the same Profiles to be ready, and exits non-zero, naming the Profile and its failed checks. A Worker with no ready Profile updates as before. The Windows installer does not run this check yet.
