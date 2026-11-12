---
"@erainfra/agent": minor
---

The retired Hub leaves the product (ADR 0020). The Infra Agent drops its Hub mode (`connect`) and its dumbpipe links, and runs only `connect-convex`. `/install --role node` installs only Convex mode and refuses `--token`, `--hub` and `--name`, and `/install.ps1` has no Node role. `erainfra nodes list` loses its TRANSPORT column, and the `hub` App status and the `legacy` link transport are gone. The Hub, its web UI, the `portless` CLI and the Hub-era installers are no longer built. To run a Hub again, use the `v0.2.0-rc.19` release.
