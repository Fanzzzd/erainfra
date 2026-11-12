---
"@erainfra/runtime": minor
---

Firecracker guests can send apt's `http://` fetches through an apt mirror such as apt-cacher-ng. Set `RC_APT_MIRROR_URL=http://<host>:3142` on the runtime and allow the address in the egress list. A probe before each apt run sends apt direct when the mirror does not answer, so a mirror outage never fails a job. `https://` sources always go direct. See `docs/runbooks/operate-the-apt-mirror.md`.
