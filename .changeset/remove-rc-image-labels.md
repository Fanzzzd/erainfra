---
"@erainfra/backend": minor
---

The control plane no longer knows the legacy image labels `rc-linux`, `rc-mac` and `rc-win`. A job that names no image gets `ubuntu-24.04`, `macos-15` or `windows-2025`, the same images the aliases pointed at. A pre-Profile job that still asks for an old name now needs a Worker with that host label. `/runs-on?labels=` takes the real labels, such as `labels=ubuntu-24.04`.
