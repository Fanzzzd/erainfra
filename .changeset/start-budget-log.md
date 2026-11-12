---
"@erainfra/runtime": patch
---

The runtime logs `held Attempt for the start budget` only for an Attempt that waited. It logged every start before, with `held=0s`.
