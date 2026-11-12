---
"@erainfra/backend": minor
---

When the runner, not the job's own steps, fails a run, the dashboard's run page, `erainfra jobs view` and the operator API name the cause (for example, no Worker within 24 hours, Worker lost, executor killed for memory) and link the GitHub or Blacksmith page that describes the same behaviour.
