---
"@erainfra/runtime": patch
---

Guests mount their root filesystem with `noatime,nobarrier,data=writeback,journal_async_commit,commit=30`. These are GitHub's hosted-image root mount options plus `noatime`. Our image dropped them together with GRUB. Each Attempt's root is a throwaway snapshot, so each small write saved also saves a 64 KiB copy-on-write or zeroing write in the Worker's thin pool. The image boot test now fails if the guest's root mount lacks any of them.
