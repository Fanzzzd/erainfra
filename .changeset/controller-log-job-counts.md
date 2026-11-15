---
"@erainfra/controller": patch
---

The controller logs GitHub's job counts for its scale set whenever they change: available, acquired, assigned and running jobs, and registered, busy and idle runners. A job that waits while `available` stays above zero was not offered to this listener; a job that never appears there was never queued for this scale set. The counts do not change while the fleet is idle, so an idle controller logs nothing new.
