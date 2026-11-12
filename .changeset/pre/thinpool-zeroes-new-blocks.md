---
"@erainfra/runtime": patch
"@erainfra/backend": patch
---

The thin pool now zeroes every new block. Before this change the pool was created with `skip_block_zeroing`, so a guest that wrote part of a fresh 64 KiB block could read the rest of it, which could hold an earlier Attempt's data. Host setup reloads an existing pool's table in place. A new readiness check, `snapshot-block-zeroing`, fails while the pool skips zeroing, and the control plane requires it on every Firecracker Worker. Update the runtime on each Worker before deploying the control plane, or Workers on an older runtime are refused.
