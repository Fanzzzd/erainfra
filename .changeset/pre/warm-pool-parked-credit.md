---
"@erainfra/runtime": patch
---

The warm-pool setup check no longer charges parked guests twice for thin-pool room. Their writes are already missing from the free space, so the check now credits them back before it requires a full reserve per target guest, as the control plane's placement rule does. The runtime knows how many guests are parked but not which live roots they own, so it credits the smallest writes among the live roots, which never exceeds what the parked guests wrote. The check can only pass more often than before.
