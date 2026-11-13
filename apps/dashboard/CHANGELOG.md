# @erainfra/dashboard

## 0.2.0-rc.22

### Minor Changes

- [#370](https://github.com/Fanzzzd/erainfra/pull/370) [`2f38fdd`](https://github.com/Fanzzzd/erainfra/commit/2f38fdd2e82d16c16b4e01622e443a43eb1634e6) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - The dashboard uses the shared Era design: the Era colours, type and spacing, a light theme beside the dark one that follows the system setting, and the EraInfra wordmark in a header with a green accent band. Dialogs, menus, tooltips, tabs and toasts now run on ui-sdk instead of Radix and sonner, and deleting or revoking something asks in a dialog instead of the browser's confirm box.

### Patch Changes

- [#371](https://github.com/Fanzzzd/erainfra/pull/371) [`3d339b2`](https://github.com/Fanzzzd/erainfra/commit/3d339b2ebbbe83782dbf72127805b45c64c71656) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - On narrow screens, card headers stack their action under the description, and Profile and machine names in tables stay on one line while the table scrolls. A table that scrolls sideways with nothing focusable in it takes keyboard focus, and the isolation, controller and "Not reporting" hints on Machines open from the keyboard.
- Updated dependencies [[`d5aae66`](https://github.com/Fanzzzd/erainfra/commit/d5aae6618abee8d7adb6e1fd8ab56c985c697ed7), [`aa8534e`](https://github.com/Fanzzzd/erainfra/commit/aa8534ede2e4e1998faa880c70bb508d8442a5ed)]:
  - @erainfra/backend@0.2.0-rc.22

## 0.2.0-rc.21

### Patch Changes

- [#363](https://github.com/Fanzzzd/erainfra/pull/363) [`f1b5ba3`](https://github.com/Fanzzzd/erainfra/commit/f1b5ba3b628c64eeb06465225c72cda06465b508) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Retire the dashboard's CI GitHub App. The Manifest flow (`/github/app/new`, `/github/app/callback`), the dashboard panel "Legacy webhook runner migration" and the `githubApp` and `githubAppSetups` tables are removed, and the backend no longer reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` or `GITHUB_WEBHOOK_SECRET`. `/github/webhook` now verifies every delivery against the deploy App's `ERAINFRA_GH_WEBHOOK_SECRET` only, so a leftover repository webhook signed with `GITHUB_WEBHOOK_SECRET` gets 401. The `actions/runner` release read uses the controller GitHub App's token, else none.

- [#360](https://github.com/Fanzzzd/erainfra/pull/360) [`04d0757`](https://github.com/Fanzzzd/erainfra/commit/04d07572485d96ccecd4442e4dfc8a056f0c517f) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Remove the pre-Profile webhook job path. The backend no longer stores `workflow_job` deliveries, assigns them to Workers as commands, or asks GitHub to redeliver missed ones; `/github/webhook` acts only on `push`. `agentApi:pendingCommands`, `agentApi:claim` and `agentApi:report` are gone, so a Worker needs Action Runner Agent v0.2.0-rc.20 or later. The dashboard's Legacy jobs page and the `ALLOWED_REPOS`, `ALLOW_PUBLIC_REPOS` and `GITHUB_PAT` settings are removed. Reading the `actions/runner` release list now falls back to the controller GitHub App's token instead of `GITHUB_PAT`.

  The `jobs`, `commands`, `runnerDeletions`, `webhookRecovery` and `webhookRecoveryState` tables leave the schema. Convex does not delete documents a removed table still holds; delete them from the Convex dashboard.

- Updated dependencies [[`e6bdde2`](https://github.com/Fanzzzd/erainfra/commit/e6bdde29ccd2e745587cb05114d449b062123f04), [`cb38ae4`](https://github.com/Fanzzzd/erainfra/commit/cb38ae4d6a7817bda6391d594457aad7d8508a0b), [`cb38ae4`](https://github.com/Fanzzzd/erainfra/commit/cb38ae4d6a7817bda6391d594457aad7d8508a0b), [`f1b5ba3`](https://github.com/Fanzzzd/erainfra/commit/f1b5ba3b628c64eeb06465225c72cda06465b508), [`04d0757`](https://github.com/Fanzzzd/erainfra/commit/04d07572485d96ccecd4442e4dfc8a056f0c517f)]:
  - @erainfra/backend@0.2.0-rc.21

## 0.2.0-rc.20

### Patch Changes

- Updated dependencies [[`8598496`](https://github.com/Fanzzzd/erainfra/commit/8598496848f8a12324d7f4c4283ebfa88e60091c), [`3d94215`](https://github.com/Fanzzzd/erainfra/commit/3d9421566361d21db9d7447900349a4cb45937da), [`d1fcdf3`](https://github.com/Fanzzzd/erainfra/commit/d1fcdf33aa6acafaab7f75617ec12b0bc2edaa8e)]:
  - @erainfra/backend@0.2.0-rc.20

## 0.2.0-rc.19

### Patch Changes

- Updated dependencies []:
  - @erainfra/backend@0.2.0-rc.19

## 0.2.0-rc.18

### Patch Changes

- Updated dependencies [[`cf3d1cb`](https://github.com/Fanzzzd/erainfra/commit/cf3d1cb34ab87aba4d1643035539922538b53c1d)]:
  - @erainfra/backend@0.2.0-rc.18

## 0.2.0-rc.17

### Patch Changes

- Updated dependencies [[`f8232bb`](https://github.com/Fanzzzd/erainfra/commit/f8232bbb3c8d4745fdcb47cd82e828a0f4ed9ffb), [`2c53b30`](https://github.com/Fanzzzd/erainfra/commit/2c53b30905973622849063d50cddfdada2b6545e), [`f8232bb`](https://github.com/Fanzzzd/erainfra/commit/f8232bbb3c8d4745fdcb47cd82e828a0f4ed9ffb), [`4107de7`](https://github.com/Fanzzzd/erainfra/commit/4107de78e590ed78f680918d3ce287cbd3a1895e), [`3c87ca2`](https://github.com/Fanzzzd/erainfra/commit/3c87ca2b2b5d4acbbc36eef9fcc2dc5c91d173a2)]:
  - @erainfra/backend@0.2.0-rc.17

## 0.2.0-rc.16

### Patch Changes

- [#301](https://github.com/Fanzzzd/erainfra/pull/301) [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5) Thanks [@Fanzzzd](https://github.com/Fanzzzd)! - Setup and readiness messages, and the dashboard's alert and metrics notes, now point to the current docs pages instead of README sections that moved to `docs/`.
- Updated dependencies [[`d736199`](https://github.com/Fanzzzd/erainfra/commit/d7361998361055fe11b68db4b705d67b258ebdd2), [`9538ddc`](https://github.com/Fanzzzd/erainfra/commit/9538ddce10f521c6dad33826f5ad7f1b2fb7c5b5), [`fffd457`](https://github.com/Fanzzzd/erainfra/commit/fffd45780697855e4d0641910038ce99b2ddee38), [`83e5b0b`](https://github.com/Fanzzzd/erainfra/commit/83e5b0b0a5ace2dea0515096323662ecb037f36f), [`3ba2b4b`](https://github.com/Fanzzzd/erainfra/commit/3ba2b4bbc31118d1997ab14e08c6c6df08ed015c), [`35a1cf5`](https://github.com/Fanzzzd/erainfra/commit/35a1cf5524d4a188ec4acfccf2ddf7dc51b26d8f)]:
  - @erainfra/backend@0.2.0-rc.16
