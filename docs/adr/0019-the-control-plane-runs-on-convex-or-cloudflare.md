# ADR 0019: The control plane runs on Convex or on Cloudflare

- Status: Accepted; implementation in progress (Convex stays the production platform until the
  Cloudflare platform passes the same tests and a staged cutover)
- Date: 2026-11-11
- Owners: EraInfra
- Related: [ADR 0011](0011-one-erainfra-cli-over-an-operator-api.md),
  [ADR 0016](0016-nodes-meet-over-iroh-and-keep-state-in-convex.md)

## Context

The owner asked for the control plane to be able to move to Cloudflare, with Convex kept as an
option, and for an adapter between the two so switching stays cheap.

What depends on Convex today, measured on main at 2026-11-11:

- `packages/backend/convex`: 92 exported functions in about 33,000 lines. They make 456 `ctx.db`
  calls (114 `get`, 59 `insert`, 151 `patch`, 6 `replace`, 51 `delete`, 69 `query`), 272
  `withIndex` ranges, 112 `filter` calls, 45 `ctx.scheduler` calls, 106 `ctx.run*` calls, 9
  crons, 3 file-storage calls, Convex Auth with the Password provider, and the static-hosting
  component that serves the dashboard. There are 36 tables and no search or vector indexes.
- The dashboard calls 45 `useQuery`, 33 `useMutation` and the Convex Auth hooks.
- The Action Runner Agent holds a `ConvexClient` with 4 live subscriptions and about 15 query and
  mutation calls.
- The controller, the Infra Agent and the `erainfra` CLI speak plain HTTP (`/controller/*`,
  `/api/v1/*`, `/install`, `/runs-on`, `/metrics`). They need only a base URL.

Cloudflare facts that shape the design, from developers.cloudflare.com on 2026-11-11:

- SQLite-backed Durable Objects are GA. One object holds up to 10 GB on the Paid plan; a row or
  value up to 8 MB; a statement up to 100 KB with at most 100 bound parameters
  (durable-objects/platform/limits).
- `ctx.storage.sql.exec` is synchronous. `transactionSync(fn)` runs a synchronous callback in one
  transaction and rolls back on a throw. `BEGIN` and `SAVEPOINT` are rejected
  (durable-objects/api/sqlite-storage-api). Any `await` on I/O lets another request into the
  object (durable-objects/best-practices/rules-of-durable-objects).
- Point-in-time recovery covers 30 days; there is no export API.
- One object allows 30 s of CPU per request, alarm or WebSocket message (configurable to 5
  minutes), 128 MB of memory, about 1,000 requests a second, and 32,768 hibernatable WebSockets.
  Hibernation drops in-memory state. A socket attachment holds at most 16 KB.
- One alarm per object, delivered at least once, retried up to 6 times. Cron Triggers run at most
  once a minute.
- D1 has no interactive transactions, only `batch()`, so it cannot run a read-modify-write
  mutation.
- Workers Free allows 10 ms of CPU per request, which the control plane exceeds. Cloudflare
  means the Paid plan ($5 a month minimum).

## Decision

### The port is Convex's syscall interface

The backend keeps Convex's programming model unchanged: functions declared with the generated
`query`, `mutation`, `action` and `httpAction` builders, using `ctx.db`, `ctx.scheduler`,
`ctx.storage`, `ctx.auth` and `ctx.run*`.

Under that model, Convex's own npm package turns every `ctx` call into a syscall on a global
`Convex` object: `1.0/get`, `1.0/insert`, `1.0/shallowMerge`, `1.0/replace`, `1.0/remove`,
`1.0/queryStream`, `1.0/queryStreamNext`, `1.0/queryPage`, `1.0/db/normalizeId`,
`1.0/schedule`, `1.0/actions/query`, `1.0/actions/mutation`, `1.0/storage*` and a few metadata
calls, about 30 in all. The Convex server answers them in production. convex-test answers them in
tests, which is how it runs real backend code. That interface is the boundary:

- **Convex platform**: the Convex server answers the syscalls. No code of ours runs between the
  backend and Convex.
- **Cloudflare platform**: `packages/platform` answers the same syscalls from a Durable Object.

Argument validation, return validation, the query builder and the index-range rules stay in
Convex's own client code on both platforms, so they behave identically. The Cloudflare side
implements storage, transactions, scheduling and files, nothing else. The backend's modules load
unmodified; the Cloudflare runtime calls each registered function's `invokeQuery`,
`invokeMutation` or `invokeAction`, as convex-test does.

The alternatives cost more. Reimplementing `ctx.db` would duplicate the query builder and
validation, and drift from Convex. A repository layer or ORM written for both platforms would
rewrite all 456 data calls and lose Convex's live queries on the Convex side.

The syscall interface is internal to Convex. It is versioned (`1.0/...`) and convex-test depends
on it, but a Convex upgrade can change it. The `convex` package stays pinned, and the conformance
tests below run on every upgrade.

### The Cloudflare platform

- **Store.** One Durable Object (`ControlPlane`) holds every table in SQLite. The store is
  schema-agnostic: each document is one JSON row of `_docs`, and each index entry is one row of
  `_index`, keyed by an order-preserving hex encoding of the indexed values plus `_creationTime`
  and `_id`. SQLite's byte comparison of those keys is Convex's value order, so `withIndex` ranges,
  `order` and pagination behave as on Convex. A schema change needs no DDL; the store rebuilds an
  added or changed index when it opens. The store validates each write against the table's Convex
  validator.
- **Transactions.** A mutation buffers its writes, reads its own writes, and applies them in one
  `transactionSync` when it returns. A mutation that throws stores nothing. The object runs one
  mutation at a time, so mutations are serializable, as on Convex.
- **Actions.** An action runs outside any transaction and reaches the store only through
  `ctx.runQuery` and `ctx.runMutation`. An action that awaits a fetch must re-check state in a
  mutation afterwards, which is already the rule on Convex.
- **Live queries.** Clients hold a WebSocket to the object. The object records each subscription
  (function, arguments, tables read) in SQLite, so hibernation does not lose it, and re-runs the
  subscriptions whose tables a mutation wrote. Convex tracks reads per index range; table-level
  invalidation re-runs more often but is correct, and the control plane's write rate is low.
- **Scheduler and crons.** `ctx.scheduler.runAfter` and `runAt` write `_scheduled_functions`
  rows. The object keeps its single alarm at the earliest due row and runs due rows when it fires.
  The 9 crons become Cron Triggers on the Worker, which call into the object.
- **HTTP.** A Worker in front routes the existing HTTP paths to `httpAction` handlers and serves
  the dashboard from Workers Static Assets with SPA fallback.
- **Files.** `ctx.storage` maps to R2.
- **Logs and metrics.** High-volume tables (logs, Attempt metrics) are the cost driver: every
  index entry and every retention delete is a billed row write. They move to a second object or
  to R2 before a production cutover. Measure first.
- **Auth.** Convex Auth's Password provider is replaced by the same flows (sign-in, sign-up by
  invitation, sessions as signed JWTs) behind the same `getAuthUserId` call. Password hashes must
  stay verifiable after a migration; production Workers cap PBKDF2 at 100,000 iterations and cap
  `node:crypto` scrypt cost at an unpublished value, so the hash parameters are checked on a
  deployed Worker before the auth phase lands.

### Clients reach the control plane through a client port

The dashboard and the Action Runner Agent call functions by name through a small client interface
(`query`, `mutation`, `action`, `onUpdate`). One implementation wraps `ConvexClient`; the other
speaks the Cloudflare object's WebSocket protocol. The Go clients keep using HTTP and need only the
base URL.

### Which platform runs is a deploy-time choice

One setting chooses the platform when the control plane is deployed. There is no runtime switch
and no dual-write. Moving between platforms is an export from one and an import into the other;
the store keeps Convex document IDs verbatim, so references survive the move.

### The same tests run on both platforms

The store's tests run each scenario against convex-test and against the SQLite store and require
the same results (`packages/platform/tests/store.test.ts`). The backend's existing test suite runs
against both platforms before the Cloudflare platform is offered for production.

Where convex-test and production Convex disagree, the store follows production Convex. The known
case: convex-test compares filter operands with JavaScript's `>` and `<`, so `null > -1` is true
there; Convex's value order puts null below every number.

## Phases

1. The store, with differential tests against convex-test. (This ADR's pull request.)
2. The function runtime on Cloudflare: the syscall layer over the store, the Durable Object host,
   nested calls, the scheduler and alarm, Cron Triggers, HTTP routing, R2 storage. The backend's
   test suite runs on it.
3. The client port, then the dashboard and the Action Runner Agent on it.
4. Auth.
5. Deploy tooling (`wrangler`), export and import between platforms, and an end-to-end run of the
   rc-e2e Profile against a Cloudflare deployment.
6. A staged cutover, if the owner chooses Cloudflare for production.

## Consequences

- The backend may only use the syscalls the Cloudflare platform answers. A new Convex feature
  (search indexes, vector search, components) needs a Cloudflare implementation or stays out. An
  unanswered syscall fails loudly on Cloudflare, and the conformance tests catch it first.
- Live queries on Cloudflare re-run more often than on Convex, because invalidation is per table.
- On Cloudflare the whole control plane lives in one Durable Object. Its limits (about 1,000
  requests a second, 10 GB, 128 MB of memory) are far above today's load; the logs and metrics
  move-out above keeps them so.
- Backups on Cloudflare are point-in-time recovery for 30 days plus our own export to R2.
