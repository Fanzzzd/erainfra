# Agent instructions

Read `CONTEXT.md` before you change code or docs. A capitalized term there (Worker, Node, Profile,
Attempt, Runner, Hub) means exactly what `CONTEXT.md` says, in code, comments, docs and commits.

## Names

- Never use `agent` alone as a name. Say Action Runner Agent or Infra Agent.
- "Runner" means GitHub's ephemeral runner, never one of our daemons.
- Do not name a component after a property every component shares, such as "edge" or "outbound".
- Repository paths and workspace package names may change. An identifier a running system already
  holds may not: the `portless-data` volume, `PORTLESS_*` and `RC_*` variables,
  `/etc/portless/agent.env`, `portless-agent.service`, `runner-center-*` units, published package
  names and download paths. `CONTEXT.md` naming rule 4 has the full list. CI fails a pull request
  that removes a frozen `portless` identifier from the tree.

## Checks before a pull request

- JavaScript and TypeScript: `pnpm check` (Oxlint, Oxfmt, type check, tests).
- Go: `go test ./...`, `go vet ./...`, `GOOS=linux golangci-lint run ./...` with golangci-lint
  v2.15.0, and `GOOS=linux govulncheck ./...`.
- Rust, in `apps/mesh`: `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`,
  `cargo test --locked`, `cargo deny --locked check`.

A Go lint exception has the form `//nolint:<linter> // <reason>`. It names the linter and says why.

## Commits and pull requests

Conventional Commits: `type(scope): imperative summary`, at most 72 characters. Types: `feat`,
`fix`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`, `chore`. The scope is an app or package
directory, such as `runtime`, `controller` or `release`. The body explains why. Pull requests are
squash-merged, so the pull request title becomes the commit subject. `CONTRIBUTING.md` has the rest.

## Writing

English only. Short sentences with active verbs. State limits and unshipped behavior plainly. No
marketing words, no em dashes, no slogans as headings.
