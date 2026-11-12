---
"@erainfra/runtime": patch
---

The Firecracker runtime's warnings in `journalctl -u runner-center-runtime` keep their `time=`, `level=` and `msg=` fields and their messages, but the level now reads `WARN` or `INFO` instead of `warning` or `info`, and the time carries milliseconds.
