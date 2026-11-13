# @erainfra/controller

## 0.2.0-rc.24

No changes in this release.

## 0.2.0-rc.23

No changes in this release.

## 0.2.0-rc.22

No changes in this release.

## 0.2.0-rc.21

No changes in this release.

## 0.2.0-rc.20

### Patch Changes

- [#352](https://github.com/Fanzzzd/erainfra/pull/352) [`bbb2c96`](https://github.com/Fanzzzd/erainfra/commit/bbb2c96dbd315e7d7c68a3dd402ce9ac049b5555) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The job cache no longer matches by repository name alone. The cache service refuses job facts without a GitHub repository ID unless they grant nothing, as the controller's cold facts do, and answers such a push `400 facts carry no repository ID`. An index entry without an ID belongs to no repository: no job restores it, the first save under the name removes it, and the next sweep evicts it with reason `no repository ID`. The controller publishes cold facts for a workflow run that names no repository ID. Every controller since v0.2.0-rc.11 pushes the ID.

## 0.2.0-rc.19

No changes in this release.

## 0.2.0-rc.18

No changes in this release.

## 0.2.0-rc.17

No changes in this release.

## 0.2.0-rc.16

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.
