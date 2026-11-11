---
"@erainfra/agent": patch
---

Each Infra Agent log line now names its level (`INFO`, `WARN` or `ERROR`) between the timestamp and the message. The message text is unchanged, so a `journalctl | grep` for a message still matches.
