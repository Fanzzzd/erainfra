# @erainfra/runtime

## 0.2.0-rc.16

### Minor Changes

- [#316](https://github.com/Fanzzzd/erainfra/pull/316) [`1e4f95e`](https://github.com/Fanzzzd/erainfra/commit/1e4f95ed478055058dc1c2d112d7428d055d66da) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - A save of a key another job is still uploading is skipped, as GitHub's own cache does. Before, a cold burst of jobs that all missed one key each uploaded the same bytes, and the newest commit won.

- [#306](https://github.com/Fanzzzd/erainfra/pull/306) [`da5ad28`](https://github.com/Fanzzzd/erainfra/commit/da5ad28abac6503cc92ea0da2eb0f0953986795d) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Firecracker guests can send apt's `http://` fetches through an apt mirror such as apt-cacher-ng. Set `RC_APT_MIRROR_URL=http://<host>:3142` on the runtime and allow the address in the egress list. A probe before each apt run sends apt direct when the mirror does not answer, so a mirror outage never fails a job. `https://` sources always go direct. See `docs/runbooks/operate-the-apt-mirror.md`.

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.

- [#294](https://github.com/Fanzzzd/erainfra/pull/294) [`98ab6f3`](https://github.com/Fanzzzd/erainfra/commit/98ab6f319fce4a220374e034729f06e1a60997b9) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The Firecracker runtime's warnings in `journalctl -u runner-center-runtime` keep their `time=`, `level=` and `msg=` fields and their messages, but the level now reads `WARN` or `INFO` instead of `warning` or `info`, and the time carries milliseconds.
