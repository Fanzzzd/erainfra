---
"@erainfra/runtime": patch
"@erainfra/agent": patch
---

The runtime deletes Image Releases no Profile of its Worker uses. Once an hour the Agent sends the Image Releases of its Firecracker Profiles; the runtime keeps those, its warm pools' and the newest other one, and deletes the rest. ubuntu0 held seven, about 10 GiB each unpacked, with every Profile on one. `runner-center-runtime prune-images` runs it by hand.
