# Contributing to EraInfra

Read [CONTEXT.md](CONTEXT.md) first. It defines the words this repository uses and the identifiers
that must never be renamed. [AGENTS.md](AGENTS.md) is the short version for coding agents.

## Set up

Requirements: Node.js 22+, pnpm 11, Go 1.27.4+, and a Convex account or local deployment. Rust work
in `apps/mesh` also needs rustup, which installs the compiler `apps/mesh/rust-toolchain.toml` pins.

```bash
pnpm install
pnpm dev
```

## Checks

Run the gate for every language you touched before you open a pull request. CI runs the same
commands.

JavaScript and TypeScript, for the whole workspace: lint, formatting, type checking and tests.

```bash
pnpm check
```

Go, from the repository root. golangci-lint must be v2.15.0, the version CI pins. It reads
`.golangci.yml` and fails on any file `gofmt` or `goimports` would change.

```bash
go test ./...
go vet ./...
GOOS=linux golangci-lint run ./...
go install golang.org/x/vuln/cmd/govulncheck@v1.9.0
GOOS=linux govulncheck ./...
```

A Go lint exception names its linter and gives a reason on the same line:
`//nolint:errcheck // read-only body; a close error loses nothing`. golangci-lint rejects a
`//nolint` without both, and one that no longer silences anything.

Rust, in `apps/mesh`:

```bash
cd apps/mesh
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo deny --locked check   # cargo-deny 0.20.2; policy in apps/mesh/deny.toml
```

README.md, "Develop locally", lists what else CI checks.

## Code rules

- Keep platform lifecycle logic behind the executor boundary.
- Preserve single-use secret handling. A Runner runs inside the isolation boundary with only a
  single-use JIT token.
- Never rename an identifier a running system already holds. `CONTEXT.md` naming rule 4 lists
  them, and CI fails a pull request that removes a frozen `portless` identifier.
- Keep a non-test source file (`.go`, `.ts`, `.tsx`, `.rs`, `.mjs`) at 900 lines or fewer. When a
  file nears the cap, split it where its interface is small, not by moving its tail into a second
  file. `pnpm check:structure` (`scripts/check-structure.mjs`) enforces this in `pnpm check` and in
  CI. It counts lines as EraDB does, so a file ending in a newline counts one more than `wc -l`.
  The files over the cap today are listed in the script with a reason each; remove an entry when
  its file is split.

## Commits and pull requests

Commit subjects use Conventional Commits:

```text
type(scope): imperative summary
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`, `chore`.
- The scope is the app or package directory the change is about, such as `runtime`,
  `controller`, `infra-agent`, `release` or `cache-service`. Use `deps` for dependency updates.
  Leave the scope out when a change spans the repository.
- The whole subject is at most 72 characters, in the imperative ("add", not "added").
- The body explains why the change is needed. The diff already shows what changed.
- One logical change per commit.
- Review-round IDs go in a trailer, such as `Refs: R14-L1`, never in the subject.

Pull requests are squash-merged, so the pull request title becomes the commit subject on `main`.
CI checks the title against the rules above. Recent pull request bodies use three sections:
Summary, Evidence (before and after), and Merge Danger.

## Versions and changelogs

Changesets owns the version numbers and the CHANGELOG files; nobody edits either by hand. A pull
request that changes a released package carries a changeset, and CI fails one that does not.
[.changeset/README.md](.changeset/README.md) says which package to name, which bump to pick and how
to write the operator-facing summary. A change users will not notice carries an empty changeset
(`pnpm changeset --empty`).

## Writing

Everything in the repository is English: code, comments, docs, commit messages and UI strings.
Unicode test inputs are the only exception. Write in short sentences with active verbs. State
limits and unshipped behavior plainly. Do not use marketing words, em dashes or slogans as
headings.
