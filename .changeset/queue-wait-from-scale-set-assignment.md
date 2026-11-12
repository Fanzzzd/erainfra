---
"@erainfra/backend": patch
---

When GitHub sends no queue time, queue wait counts from when GitHub assigned the job to the Profile's scale set. GitHub's scale-set messages have so far carried no queue time, so `queueWaitMs` was null on every scale-set Attempt. `queuedAt` stays null. The API returns the new start as `scaleSetAssignedAt`, and `erainfra jobs view` prints it as "On scale set".
