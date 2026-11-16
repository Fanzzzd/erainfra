---
"@erainfra/runtime": patch
---

The runtime no longer logs the runner's diagnostic when the runner ran a job and exited 0. An ephemeral runner logs "SocketException (125): Operation canceled" as an error on every clean exit, so the line appeared on all 265 clean exits on ubuntu0 since 2026-11-15 and explained nothing. Unclean exits still log it.
