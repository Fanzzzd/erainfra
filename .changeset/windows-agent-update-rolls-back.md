---
"@erainfra/backend": patch
---

The Windows installer's `-Update` (and `rc.ps1 update`) now runs the same health check as `rc update` on Linux and macOS. Before the swap, it records which Profiles `GET /agents/readiness` reports this Worker ready for. After the new Action Runner Agent starts, each of those Profiles must report ready again within `-ReadyTimeout` seconds (default 900). If one reports degraded or failed, or the deadline passes, the installer restores `agent.previous`, starts it, waits for the same Profiles to be ready, and exits non-zero, naming the Profile and its failed checks. If the readiness read fails before the swap, the update stops and leaves the running Agent in place. The machine token travels only in an in-process request header. Both installers now take the deadline and the readiness reader from one module, `updateHealthCheck.ts`.

The Windows scheduled task now runs as `DOMAIN\user`. A missing backslash had made the account name `DOMAINuser`.
