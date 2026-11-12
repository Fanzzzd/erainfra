# @erainfra/agent

## 0.2.0-rc.20

### Minor Changes

- [#350](https://github.com/Fanzzzd/erainfra/pull/350) [`6130f39`](https://github.com/Fanzzzd/erainfra/commit/6130f390d4406db4aeddeedbd2a1196a70428db4) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The retired Hub leaves the product (ADR 0020). The Infra Agent drops its Hub mode (`connect`) and its dumbpipe links, and runs only `connect-convex`. `/install --role node` installs only Convex mode and refuses `--token`, `--hub` and `--name`, and `/install.ps1` has no Node role. `erainfra nodes list` loses its TRANSPORT column, and the `hub` App status and the `legacy` link transport are gone. The Hub, its web UI, the `portless` CLI and the Hub-era installers are no longer built. To run a Hub again, use the `v0.2.0-rc.19` release.

### Patch Changes

- [#347](https://github.com/Fanzzzd/erainfra/pull/347) [`90c88a1`](https://github.com/Fanzzzd/erainfra/commit/90c88a1ddd16875b121a8958a5b5535a6b00479a) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The Action Runner Agent no longer subscribes to `agentApi:pendingCommands` or calls `agentApi:claim` and `agentApi:report`. Those served the pre-Profile webhook job path, which has created no command in production. It still sends `agentApi:heartbeat`.

## 0.2.0-rc.19

### Patch Changes

- [#337](https://github.com/Fanzzzd/erainfra/pull/337) [`7f3f275`](https://github.com/Fanzzzd/erainfra/commit/7f3f2756df008fcc6a31d5bdeb8192c009ecb724) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The runtime deletes Image Releases no Profile of its Worker uses. Once an hour the Agent sends the Image Releases of its Firecracker Profiles; the runtime keeps those, its warm pools' and the newest other one, and deletes the rest. ubuntu0 held seven, about 10 GiB each unpacked, with every Profile on one. `runner-center-runtime prune-images` runs it by hand.

## 0.2.0-rc.18

### Patch Changes

- [#330](https://github.com/Fanzzzd/erainfra/pull/330) [`874c13b`](https://github.com/Fanzzzd/erainfra/commit/874c13bf19beca8f6cfb1f640328f4487fbe7b8f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Guests and Docker job containers ask the resolver with `options edns0 timeout:1 attempts:3`. glibc waits 5 s for a lost DNS answer by default, and the resolvers sit across the Worker's uplink. On ubuntu0, 2 of 360 sampled lookups to github.com took 5 s; with this change a lost answer costs 1 s. `testdata/resolver-options.json` holds the option list, and the Go and TypeScript tests both read it.

- [#333](https://github.com/Fanzzzd/erainfra/pull/333) [`cf3d1cb`](https://github.com/Fanzzzd/erainfra/commit/cf3d1cb34ab87aba4d1643035539922538b53c1d) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Firecracker Workers space Attempt starts out within a start budget. The runtime holds a start, warm claims included, while two Attempts are still in their first 60 seconds or the host's I/O pressure (io "some" avg10) is at 30% or more, for at most 120 seconds, in arrival order. The Agent forwards the state in its heartbeat, and `/runs-on` answers the fallback with reason `over-start-budget` while every ready Worker is over budget. On ubuntu0, six Attempts starting together held I/O stall at 40 to 60% for minutes and slowed tests on every job. `ERAINFRA_MAX_STARTING`, `ERAINFRA_START_WINDOW_S`, `ERAINFRA_IO_PRESSURE_LIMIT` and `ERAINFRA_MAX_START_HOLD_S` change the limits; `docs/workers.md` has the details. Deploy the control plane before the Agent. An older control plane rejects the new heartbeat field; the Agent then retries without it.

## 0.2.0-rc.17

No changes in this release.

## 0.2.0-rc.16

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.

- [#294](https://github.com/Fanzzzd/erainfra/pull/294) [`98ab6f3`](https://github.com/Fanzzzd/erainfra/commit/98ab6f319fce4a220374e034729f06e1a60997b9) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Each Infra Agent log line now names its level (`INFO`, `WARN` or `ERROR`) between the timestamp and the message. The message text is unchanged, so a `journalctl | grep` for a message still matches.
