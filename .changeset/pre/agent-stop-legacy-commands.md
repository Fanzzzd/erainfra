---
"@erainfra/agent": patch
---

The Action Runner Agent no longer subscribes to `agentApi:pendingCommands` or calls `agentApi:claim` and `agentApi:report`. Those served the pre-Profile webhook job path, which has created no command in production. It still sends `agentApi:heartbeat`.
