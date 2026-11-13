---
"@erainfra/runtime": patch
"@erainfra/backend": patch
---

A Worker without `/etc/protocols` (no `netbase` package) is ready again. nft prints `meta l4proto { 6, 17 }` there instead of `{ tcp, udp }`, and the runtime's `job-network-policy` check failed readiness on `rc:record-flows`. The check now reads 6 and 17 as tcp and udp; any other number still fails. Worker-host provisioning now requires `iptables`, which the CNI plugins and guest address recovery use, instead of failing readiness after install.
