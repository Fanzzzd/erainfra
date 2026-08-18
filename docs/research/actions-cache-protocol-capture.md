# What the Actions cache clients actually call

Captured on 2026-08-18 from real traffic, not from a changelog. Every request below was made by an
unmodified released client against a throwaway HTTP endpoint that logged method, path, headers and
body and answered with the shapes GitHub's service answers with. This document is the evidence
behind [ADR 0007](../adr/0007-serve-the-actions-cache-protocol-from-an-s3-compatible-store.md);
its claims cite the `Lnnn` line numbers in [the transcript](#transcript).

## Bottom line

1. **There are two live generations and both are still in use today, in the same job.** Legacy v1 is
   a REST API under `ACTIONS_CACHE_URL`; Cache Service v2 is a twirp API under `ACTIONS_RESULTS_URL`.
   A service that implements only one of them breaks some clients.
2. **The generation is chosen by an environment variable, not by the runner version and not by the
   action version alone.** Every client we drove selects v2 only when `ACTIONS_CACHE_SERVICE_V2` is
   present, and falls back to v1 otherwise — including `actions/cache` v6.1.0, released 2026-06-26
   (L001–L006 vs L007–L012). The pinned runner sets that variable from a server-delivered job flag;
   see [What the pinned runner injects](#what-the-pinned-runner-injects).
3. **Client version still decides, in both directions.** `actions/cache` v4.0.2 has no v2 code path
   at all and stays on v1 even with the flag set (L013–L018). BuildKit's `type=gha` exporter is the
   mirror image: driven by buildx v0.20.1 it stays on v1 _even with the flag set_ (L147–L164),
   because that buildx does not forward the flag to the builder; driven by buildx v0.36.1 the same
   BuildKit goes v2 (L165–L194). Since `docker/setup-buildx-action` installs the latest buildx at
   job time, this is not a property EraInfra controls.
4. **A miss is not a 404.** On v1 it is `204 No Content` with an empty body (L001). On v2 it is
   `200 OK` with `{"ok": false}` (L007). Getting this wrong is not free: answering a v2 miss with a
   twirp `404` costs a warning and a lost cache (L123); answering it with a `500` costs five
   attempts and about 30 seconds of wall clock per restore step before the same lost cache (L124–L128).
5. **The v2 upload path is Azure Blob, and BuildKit segfaults if it is not.** `signed_upload_url`
   is consumed by an Azure Blob SDK: staged block `PUT`s and an XML `BlockList` commit
   (L033–L037, L081–L085). BuildKit's client dereferences `x-ms-request-id` from the commit response
   without a nil check; a commit response that omits that header **panics buildkitd** and kills the
   build. See [The BuildKit panic](#the-buildkit-panic).
6. **The v1 `keys` parameter is a prefix match, and BuildKit depends on it.** BuildKit writes its
   index entry as `index-<scope>-<n>-<hash>#1` (L069) and reads it back both as
   `index-<scope>-<n>-<hash>#` (L068) and as the bare `index-<scope>-<n>-<hash>` (L072). An exact-match-only v1 implementation makes every buildx cache import a silent miss
   with no error anywhere.

## Restore volume, measured on this repository

The point of measuring is the design question in ADR 0007: does a swap-in `erainfra/cache` action
capture the expensive traffic? For EraInfra's own `check` job (`.github/workflows/ci.yml:117-124`)
the answer is that it captures none of it.

| client in `ci.yml`                         | cache payload on the wire | transcript |
| ------------------------------------------ | ------------------------- | ---------- |
| `actions/setup-node@v7` with `cache: pnpm` | 203,848,100 B (194.4 MiB) | L020–L030  |
| `actions/setup-go@v7` with `cache: true`   | 141,265,787 B (134.7 MiB) | L042–L050  |
| `actions/cache` steps                      | none exist in the repo    | —          |

329.1 MiB per warm job, **100% of it from implicit clients** that never name a cache action. The
compressed archives came from a real `pnpm install --frozen-lockfile` of this repository's lockfile
(791 MB store) and a real `go build ./...` against its `go.mod` (280 MB module cache + 114 MB build
cache). `.github/workflows/images.yml` uses `docker/setup-buildx-action` but does not enable
`type=gha` today, so buildx contributes 0 B to EraInfra's own jobs; it is measured here because it
is the third client the design has to serve for _users'_ repositories.

## What was driven, and how

Clients are unmodified release artifacts, run by their own bundled entrypoint with the environment a
runner gives a step (`ACTIONS_CACHE_URL`, `ACTIONS_RESULTS_URL`, `ACTIONS_RUNTIME_TOKEN`,
`GITHUB_*`, `RUNNER_*`). The token is a well-formed but unsigned JWT carrying the `scp` and `ac`
claims GitHub's token carries, because BuildKit's client parses them.

| #   | client                                     | artifact                                                                |
| --- | ------------------------------------------ | ----------------------------------------------------------------------- |
| A   | `actions/cache` v6.1.0 / v4.0.2            | `dist/restore/index.js`, `dist/save/index.js` at the release tag        |
| B   | `actions/setup-node` v7.0.0, `cache: pnpm` | `dist/setup/index.js`, `dist/cache-save/index.js` at v7.0.0             |
| C   | `actions/setup-go` v7.0.0, `cache: true`   | `dist/setup/index.js`, `dist/cache-save/index.js` at v7.0.0             |
| D   | `docker buildx build --cache-to type=gha`  | buildx v0.20.1-desktop.2 and v0.36.1, both driving BuildKit **v0.32.2** |

Bundled cache libraries: `actions/cache` v6.1.0 and `setup-node` v7.0.0 carry `@actions/cache`
`^6.1.0`; `setup-go` v7.0.0 carries `^6.2.0`; `actions/cache` v4.0.2 carries `^3.2.3`. BuildKit
vendors `tonistiigi/go-actions-cache`.

The endpoint is a throwaway logger, deliberately **not** shipped in this repository — this PR
decides a design and measures a protocol, it does not begin implementing a cache service. What it
answered is fully specified by the responses in the transcript, which is what a reimplementation
needs.

### What the pinned runner injects

We pin `ghcr.io/actions/actions-runner:2.336.0`
(`apps/action-runner-agent/provisioners/provision-linux.sh:24`, `PINNED_RUNNER_VERSION` in
`apps/action-runner-agent/tests/provisioners.test.ts:25`). Its `/home/runner/bin/Runner.Worker.dll`
(SHA-256 `0c7be2904004e4e43a0f00c508c6904ef2b73eebd89c0971645efca667c81d88`) contains this
consecutive run of UTF-16 strings, which is the mapping the worker uses when it builds a step's
environment:

```
ACTIONS_RUNTIME_URL
ACTIONS_RUNTIME_TOKEN
CacheServerUrl
ACTIONS_CACHE_URL
PipelinesServiceUrl
ACTIONS_ID_TOKEN_REQUEST_URL
ACTIONS_ID_TOKEN_REQUEST_TOKEN
ResultsServiceUrl
ACTIONS_RESULTS_URL
ACTIONS_CACHE_MODE
ACTIONS_ORCHESTRATION_ID
...
actions_uses_cache_service_v2
ACTIONS_CACHE_SERVICE_V2
```

Read as pairs: the runner maps the job message's `CacheServerUrl` to `ACTIONS_CACHE_URL`, its
`ResultsServiceUrl` to `ACTIONS_RESULTS_URL`, and the **feature flag** `actions_uses_cache_service_v2`
to `ACTIONS_CACHE_SERVICE_V2`. The pinned runner therefore speaks neither generation itself; it
relays what the service told it, and the clients choose. Whoever composes the job environment
chooses the generation.

**Unmeasured:** we did not run a job through the pinned runner end to end, because that needs a real
scale-set Attempt bound to a repository. The string table proves the mapping exists in the shipped
binary; it does not prove the exact conditions under which the service sets the flag.

### The BuildKit panic

The first v2 buildx run answered `PUT ?comp=blocklist` with `201` and an `ETag` but no
`x-ms-request-id`. BuildKit did not fail the export — it crashed:

```
panic: runtime error: invalid memory address or nil pointer dereference
[signal SIGSEGV: segmentation violation code=0x1 addr=0x0 pc=0xcd2a7c]
github.com/tonistiigi/go-actions-cache.(*Cache).uploadV2(...)
	/src/vendor/github.com/tonistiigi/go-actions-cache/cache_v2.go:74
github.com/moby/buildkit/cache/remotecache/gha.(*exporter).Finalize(...)
	/src/cache/remotecache/gha/gha.go:289
```

The client had already uploaded every byte. `cache_v2.go:74` logs `*resp.RequestID` from the commit
response, and `RequestID` is a `*string`. The build failed with
`ERROR: failed to receive status: rpc error: code = Unavailable desc = error reading from server: EOF`,
which names nothing about the cache. Adding `x-ms-request-id` to the blob responses fixed it and the
same build then round-tripped cleanly (L078–L120).

### Miss versus error, per client

| condition                             | `actions/cache` v6.1.0                                                                 | BuildKit `type=gha`                        |
| ------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| v1 miss, `204` (correct)              | silent miss, step succeeds (L001)                                                      | silent miss, build continues (L051)        |
| v1 miss answered `404`                | `::warning::Failed to restore: Cache service responded with 404`, step succeeds (L121) | not driven                                 |
| v1 `500`                              | not retried, warning, step succeeds (L122)                                             | not driven                                 |
| v2 miss, `200 {"ok":false}` (correct) | silent miss, step succeeds (L007)                                                      | silent miss, build continues (L078)        |
| v2 miss answered twirp `404`          | warning, not retried, step succeeds (L123)                                             | vertex `ERROR: not_found`, build succeeds† |
| v2 `500`                              | 5 attempts, ~30 s of backoff, warning, step succeeds (L124–L128)                       | vertex `ERROR: internal`, build succeeds†  |

† The two BuildKit rows come from separate fault runs that are not in the transcript below; the
build printed `#4 importing cache manifest from gha:…` followed by `#4 ERROR: not_found` (and
`ERROR: internal`) and still exited 0. "not driven" means exactly that — we did not run it and are
not inferring it from the other client.

Restores degrade rather than fail in every shape we tried. Uploads do not: the panic above is a
failed build from a malformed _success_ response.

## Endpoint reference, as measured

### Legacy v1 — REST, under `ACTIONS_CACHE_URL`

- `GET  _apis/artifactcache/cache?keys=<comma-separated prefixes>&version=<sha256>`
  → `200 {"cacheKey","scope","archiveLocation"}` on hit, **`204` with no body on miss**.
  `keys` is prefix-matched: L072 asks for `index-D1-1-f921bd05` and is answered with
  `index-D1-1-f921bd05#1`.
- `POST _apis/artifactcache/caches` body `{"key","version","cacheSize"?}` → `201 {"cacheId"}`.
  `cacheSize` is sent by `@actions/cache` (L020) and omitted by BuildKit (L053).
- `PATCH _apis/artifactcache/caches/<cacheId>` with `Content-Range: bytes a-b/*`, body is raw
  archive bytes. `@actions/cache` uses **32 MiB** chunks, up to 4 concurrently, out of order
  (L021–L027). BuildKit sends the whole blob in one PATCH (L054).
- `POST _apis/artifactcache/caches/<cacheId>` body `{"size"}` → `204` commits (L028).
- Download is a plain `GET` of `archiveLocation` (L030), which need not be on the cache host.

### Cache Service v2 — twirp, under `ACTIONS_RESULTS_URL`

All three are `POST` with `Content-Type: application/json` to
`twirp/github.actions.results.api.v1.CacheService/<Method>`:

- `GetCacheEntryDownloadURL` `{"key","restore_keys"?,"version"}` →
  `{"ok":true,"signed_download_url","matched_key"}` on hit, `{"ok":false,...}` on miss, always
  `200` (L007, L011).
- `CreateCacheEntry` `{"key","version"}` → `{"ok":true,"signed_upload_url"}` (L008).
- `FinalizeCacheEntryUpload` `{"key","size_bytes","version"}` → `{"ok":true,"entry_id"}` (L010).
  `size_bytes` arrives as a **JSON string** from `@actions/cache` (L038) and as a **JSON number**
  from BuildKit (L114). Both must be accepted.
- The signed URL is driven by an Azure Blob SDK (`azsdk-go-azblob/v1.5.0` from BuildKit,
  `@azure/storage-blob` from `@actions/cache`). Small blobs go as a single `PUT` (L098); larger ones
  as `PUT ?comp=block&blockid=<base64>` per block — 64 MiB blocks from `@actions/cache` (L034–L036),
  1 MiB from BuildKit — followed by `PUT ?comp=blocklist` with an XML `<BlockList>` (L037).
  The commit response **must** carry `x-ms-request-id`.

## Transcript

Bodies are abbreviated; binary payloads show their size. `{ACTIONS_CACHE_URL}` stands for the
per-job path prefix the legacy URL carries.

### A1-actions-cache-6.1.0-default

**phase: miss**

```
L001  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=key-A1&version=b34e6f1cc07875b8…
      <-- 204 <0 bytes>
```

**phase: save**

```
L002  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"key-A1","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960","cacheSize":8010521}
      <-- 201 {"cacheId":782669}
L003  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/782669
      req  <8010521 B binary>
      <-- 204 <0 bytes>
L004  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/782669
      req  {"size":8010521}
      <-- 204 <0 bytes>
```

**phase: hit**

```
L005  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=key-A1&version=b34e6f1cc07875b8…
      <-- 200 {"cacheKey":"key-A1","scope":"refs/heads/main","archiveLocation":"http://127.0.0.1:8721/blob/v1-782669.tzst"}
L006  GET {signed url}/v1-782669.tzst
      <-- 200 <8010521 bytes streamed>
```

### A2-actions-cache-6.1.0-v2flag

**phase: miss**

```
L007  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"key-A2","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
```

**phase: save**

```
L008  POST twirp CacheService/CreateCacheEntry
      req  {"key":"key-A2","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 200 {"ok":true,"signed_upload_url":"http://127.0.0.1:8721/blob/v2-e14f99f6-9594-4034-a1b4-055f49c70891.tzst?sig=stand-in&se=2030-01-01"}
L009  PUT {signed url}/v2-e14f99f6-9594-4034-a1b4-055f49c70891.tzst
      req  <8010403 B binary>
      <-- 201 <0 bytes>
L010  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"key-A2","size_bytes":"8010403","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 200 {"ok":true,"entry_id":"424242"}
```

**phase: hit**

```
L011  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"key-A2","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 200 {"ok":true,"signed_download_url":"http://127.0.0.1:8721/blob/v2-e14f99f6-9594-4034-a1b4-055f49c70891.tzst?sig=stand-in","matched_key":"key-A2"}
L012  GET {signed url}/v2-e14f99f6-9594-4034-a1b4-055f49c70891.tzst
      <-- 200 <8010403 bytes streamed>
```

### A3-actions-cache-4.0.2-v2flag

**phase: miss**

```
L013  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=key-A3&version=b34e6f1cc07875b8…
      <-- 204 <0 bytes>
```

**phase: save**

```
L014  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"key-A3","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960","cacheSize":8010447}
      <-- 201 {"cacheId":52297}
L015  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/52297
      req  <8010447 B binary>
      <-- 204 <0 bytes>
L016  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/52297
      req  {"size":8010447}
      <-- 204 <0 bytes>
```

**phase: hit**

```
L017  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=key-A3&version=b34e6f1cc07875b8…
      <-- 200 {"cacheKey":"key-A3","scope":"refs/heads/main","archiveLocation":"http://127.0.0.1:8721/blob/v1-52297.tzst"}
L018  GET {signed url}/v1-52297.tzst
      <-- 200 <8010447 bytes streamed>
```

### B1-setup-node-7.0.0-default

**phase: miss**

```
L019  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154&version=13b0cbcf39f1eacf…
      <-- 204 <0 bytes>
```

**phase: save**

```
L020  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","version":"13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31","cacheSize":203848100}
      <-- 201 {"cacheId":358496}
L021  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L022  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L023  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L024  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L025  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <2521508 B binary>
      <-- 204 <0 bytes>
L026  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L027  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L028  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358496
      req  {"size":203848100}
      <-- 204 <0 bytes>
```

**phase: hit**

```
L029  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154&version=13b0cbcf39f1eacf…
      <-- 200 {"cacheKey":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","scope":"refs/heads/main","archiveLocation":"http://127.0.0.1:8721/blob/v
L030  GET {signed url}/v1-358496.tzst
      <-- 200 <203848100 bytes streamed>
```

### B2-setup-node-7.0.0-v2flag

**phase: miss**

```
L031  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","version":"13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31"}
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
```

**phase: save**

```
L032  POST twirp CacheService/CreateCacheEntry
      req  {"key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","version":"13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31"}
      <-- 200 {"ok":true,"signed_upload_url":"http://127.0.0.1:8721/blob/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?sig=stand-in&se=2030-01-01"}
L033  PUT {signed url}/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?comp=block&blockid=<64-char+base64+block+id>
      req  <2775203 B binary>
      <-- 201 <0 bytes>
L034  PUT {signed url}/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?comp=block&blockid=<64-char+base64+block+id>
      req  <67108864 B binary>
      <-- 201 <0 bytes>
L035  PUT {signed url}/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?comp=block&blockid=<64-char+base64+block+id>
      req  <67108864 B binary>
      <-- 201 <0 bytes>
L036  PUT {signed url}/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?comp=block&blockid=<64-char+base64+block+id>
      req  <67108864 B binary>
      <-- 201 <0 bytes>
L037  PUT {signed url}/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?comp=blocklist
      req  <xml 402B>
      <-- 201 <0 bytes>
L038  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","size_bytes":"204101795","version":"13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31"}
      <-- 200 {"ok":true,"entry_id":"424242"}
```

**phase: hit**

```
L039  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2b85871b240918321ce3d4cc13f099bec963093faf7a4154","version":"13b0cbcf39f1eacfbd22d7a93564786f34bf3f11397a4a1aa82ec6753d628f31"}
      <-- 200 {"ok":true,"signed_download_url":"http://127.0.0.1:8721/blob/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst?sig=stand-in","matched_key":"node-cache-macOS-arm64-pnpm-2f99318bf4e73abd2
L040  GET {signed url}/v2-3bdce9bb-13e9-435e-bf18-62dd4dc996f2.tzst
      <-- 200 <204101795 bytes streamed>
```

### C1-setup-go-7.0.0-default

**phase: miss**

```
L041  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=setup-go-macOS-arm64-go-1.24.5-57019200cf6d68437774163d928bbc66c1d8d979429f42b72317d6f57fadab5a&version=6311729ed309697d…
      <-- 204 <0 bytes>
```

**phase: save**

```
L042  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"setup-go-macOS-arm64-go-1.24.5-57019200cf6d68437774163d928bbc66c1d8d979429f42b72317d6f57fadab5a","version":"6311729ed309697d6f389ac79214d894faee98551769f74ca1f06395cc384ffd","cacheSize":141265787}
      <-- 201 {"cacheId":334311}
L043  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/334311
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L044  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/334311
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L045  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/334311
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L046  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/334311
      req  <7048059 B binary>
      <-- 204 <0 bytes>
L047  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/334311
      req  <33554432 B binary>
      <-- 204 <0 bytes>
L048  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/334311
      req  {"size":141265787}
      <-- 204 <0 bytes>
```

**phase: hit**

```
L049  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=setup-go-macOS-arm64-go-1.24.5-57019200cf6d68437774163d928bbc66c1d8d979429f42b72317d6f57fadab5a&version=6311729ed309697d…
      <-- 200 {"cacheKey":"setup-go-macOS-arm64-go-1.24.5-57019200cf6d68437774163d928bbc66c1d8d979429f42b72317d6f57fadab5a","scope":"refs/heads/main","archiveLocation":"http://127.0.0.1:8721/blo
L050  GET {signed url}/v1-334311.tzst
      <-- 200 <141265787 bytes streamed>
```

### D1-buildx-gha-url

**phase: miss**

```
L051  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-D1-1-f921bd05&version=693bb7016429d803…
      <-- 204 <0 bytes>
L052  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:0af15d9df66c1946af0aa6d95f6b501492e77a917f261a06d7986ecfe7a4895e&version=693bb7016429d803…
      <-- 204 <0 bytes>
L053  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:0af15d9df66c1946af0aa6d95f6b501492e77a917f261a06d7986ecfe7a4895e","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":715271}
L054  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/715271
      req  <4195736 B binary>
      <-- 204 <0 bytes>
L055  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/715271
      req  {"size":4195736}
      <-- 204 <0 bytes>
L056  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:2c81954f7a98ac3792ddbd9ce1195e78adf3927145aa3f1d61fedc862ca8d9b2&version=693bb7016429d803…
      <-- 204 <0 bytes>
L057  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:2c81954f7a98ac3792ddbd9ce1195e78adf3927145aa3f1d61fedc862ca8d9b2","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":439681}
L058  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/439681
      req  <116 B binary>
      <-- 204 <0 bytes>
L059  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/439681
      req  {"size":116}
      <-- 204 <0 bytes>
L060  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78&version=693bb7016429d803…
      <-- 204 <0 bytes>
L061  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":178994}
L062  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/178994
      req  <4092319 B binary>
      <-- 204 <0 bytes>
L063  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/178994
      req  {"size":4092319}
      <-- 204 <0 bytes>
L064  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:5ed99182b3ddc852b9454077abe3964aad212dae144d07bc9f09fb099050157e&version=693bb7016429d803…
      <-- 204 <0 bytes>
L065  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:5ed99182b3ddc852b9454077abe3964aad212dae144d07bc9f09fb099050157e","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":529563}
L066  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/529563
      req  <6293528 B binary>
      <-- 204 <0 bytes>
L067  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/529563
      req  {"size":6293528}
      <-- 204 <0 bytes>
L068  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-D1-1-f921bd05#&version=693bb7016429d803…
      <-- 204 <0 bytes>
L069  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"index-D1-1-f921bd05#1","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":499575}
L070  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/499575
      req  <2302 B binary>
      <-- 204 <0 bytes>
L071  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/499575
      req  {"size":2302}
      <-- 204 <0 bytes>
```

**phase: hit**

```
L072  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-D1-1-f921bd05&version=693bb7016429d803…
      <-- 200 {"cacheKey":"index-D1-1-f921bd05#1","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/blob/v1-499575.tzst"}
L073  GET {signed url}/v1-499575.tzst
      <-- 200 <2302 bytes streamed>
L074  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:2c81954f7a98ac3792ddbd9ce1195e78adf3927145aa3f1d61fedc862ca8d9b2&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:2c81954f7a98ac3792ddbd9ce1195e78adf3927145aa3f1d61fedc862ca8d9b2","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
L075  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
L076  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:5ed99182b3ddc852b9454077abe3964aad212dae144d07bc9f09fb099050157e&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:5ed99182b3ddc852b9454077abe3964aad212dae144d07bc9f09fb099050157e","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
L077  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:0af15d9df66c1946af0aa6d95f6b501492e77a917f261a06d7986ecfe7a4895e&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:0af15d9df66c1946af0aa6d95f6b501492e77a917f261a06d7986ecfe7a4895e","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
```

### D2-buildx-gha-url-v2

**phase: miss**

```
L078  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"index-D2-1-f921bd05","restore_keys":["index-D2-1-f921bd05"],"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L079  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","restore_keys":["buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L080  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?sig=stand-in&se=2030-01-01"}
L081  PUT {signed url}/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L082  PUT {signed url}/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L083  PUT {signed url}/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L084  PUT {signed url}/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <946591 B binary>
      <-- 201 <0 bytes>
L085  PUT {signed url}/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?comp=blocklist
      req  <xml 482B>
      <-- 201 <0 bytes>
L086  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","size_bytes":4092319,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L087  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:54898131fc6993d9098a4a7da754824b40be3d8de0334bb520c625dea6c20b66","restore_keys":["buildkit-blob-1-sha256:54898131fc6993d9098a4a7da754824b40be3d8de0334bb520c625dea6c20b66"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L088  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:54898131fc6993d9098a4a7da754824b40be3d8de0334bb520c625dea6c20b66","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?sig=stand-in&se=2030-01-01"}
L089  PUT {signed url}/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L090  PUT {signed url}/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L091  PUT {signed url}/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L092  PUT {signed url}/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L093  PUT {signed url}/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1431 B binary>
      <-- 201 <0 bytes>
L094  PUT {signed url}/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?comp=blocklist
      req  <xml 587B>
      <-- 201 <0 bytes>
L095  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:54898131fc6993d9098a4a7da754824b40be3d8de0334bb520c625dea6c20b66","size_bytes":4195735,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L096  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:6eb373546f1f273542397bbf97ac7be74c8296b206b501ea6ddc9fa5d0907cee","restore_keys":["buildkit-blob-1-sha256:6eb373546f1f273542397bbf97ac7be74c8296b206b501ea6ddc9fa5d0907cee"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L097  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:6eb373546f1f273542397bbf97ac7be74c8296b206b501ea6ddc9fa5d0907cee","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-15ff50fe-6235-44ce-bb39-f7d2c854fbf4.tzst?sig=stand-in&se=2030-01-01"}
L098  PUT {signed url}/v2-15ff50fe-6235-44ce-bb39-f7d2c854fbf4.tzst
      req  <116 B binary>
      <-- 201 <0 bytes>
L099  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:6eb373546f1f273542397bbf97ac7be74c8296b206b501ea6ddc9fa5d0907cee","size_bytes":116,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L100  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:956ea2c2753800a60387872c002db46d974048678ae743a91b15365326990162","restore_keys":["buildkit-blob-1-sha256:956ea2c2753800a60387872c002db46d974048678ae743a91b15365326990162"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L101  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:956ea2c2753800a60387872c002db46d974048678ae743a91b15365326990162","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?sig=stand-in&se=2030-01-01"}
L102  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L103  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L104  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L105  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L106  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L107  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L108  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <2071 B binary>
      <-- 201 <0 bytes>
L109  PUT {signed url}/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?comp=blocklist
      req  <xml 797B>
      <-- 201 <0 bytes>
L110  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:956ea2c2753800a60387872c002db46d974048678ae743a91b15365326990162","size_bytes":6293527,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L111  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"index-D2-1-f921bd05#","restore_keys":["index-D2-1-f921bd05#"],"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L112  POST twirp CacheService/CreateCacheEntry
      req  {"key":"index-D2-1-f921bd05#1","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-e297f265-2ef8-41dc-8760-e8f4019bea4d.tzst?sig=stand-in&se=2030-01-01"}
L113  PUT {signed url}/v2-e297f265-2ef8-41dc-8760-e8f4019bea4d.tzst
      req  <2305 B binary>
      <-- 201 <0 bytes>
L114  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"index-D2-1-f921bd05#1","size_bytes":2305,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
```

**phase: hit**

```
L115  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"index-D2-1-f921bd05","restore_keys":["index-D2-1-f921bd05"],"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_download_url":"http://host.docker.internal:8721/blob/v2-e297f265-2ef8-41dc-8760-e8f4019bea4d.tzst?sig=stand-in","matched_key":"index-D2-1-f921bd05#1"}
L116  GET {signed url}/v2-e297f265-2ef8-41dc-8760-e8f4019bea4d.tzst
      <-- 200 <2305 bytes streamed>
L117  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:6eb373546f1f273542397bbf97ac7be74c8296b206b501ea6ddc9fa5d0907cee","restore_keys":["buildkit-blob-1-sha256:6eb373546f1f273542397bbf97ac7be74c8296b206b501ea6ddc9fa5d0907cee"],"version":"693bb7016429d80
      <-- 200 {"ok":true,"signed_download_url":"http://host.docker.internal:8721/blob/v2-15ff50fe-6235-44ce-bb39-f7d2c854fbf4.tzst?sig=stand-in","matched_key":"buildkit-blob-1-sha256:6eb373546f1
L118  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","restore_keys":["buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78"],"version":"693bb7016429d80
      <-- 200 {"ok":true,"signed_download_url":"http://host.docker.internal:8721/blob/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?sig=stand-in","matched_key":"buildkit-blob-1-sha256:3f26bc2dec0
L119  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:956ea2c2753800a60387872c002db46d974048678ae743a91b15365326990162","restore_keys":["buildkit-blob-1-sha256:956ea2c2753800a60387872c002db46d974048678ae743a91b15365326990162"],"version":"693bb7016429d80
      <-- 200 {"ok":true,"signed_download_url":"http://host.docker.internal:8721/blob/v2-f6d9af4b-72f5-45b8-83d9-ab75f7d5c645.tzst?sig=stand-in","matched_key":"buildkit-blob-1-sha256:956ea2c2753
L120  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:54898131fc6993d9098a4a7da754824b40be3d8de0334bb520c625dea6c20b66","restore_keys":["buildkit-blob-1-sha256:54898131fc6993d9098a4a7da754824b40be3d8de0334bb520c625dea6c20b66"],"version":"693bb7016429d80
      <-- 200 {"ok":true,"signed_download_url":"http://host.docker.internal:8721/blob/v2-f7916ded-a37d-4cf6-b2a8-d8c33fd49555.tzst?sig=stand-in","matched_key":"buildkit-blob-1-sha256:54898131fc6
```

### fault-v1-404

**phase: restore**

```
L121  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=fault-v1-404-30421&version=b34e6f1cc07875b8…
      <-- 404 {"message":"not found"}
```

### fault-v1-500

**phase: restore**

```
L122  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=fault-v1-500-6739&version=b34e6f1cc07875b8…
      <-- 500 {"message":"boom"}
```

### fault-v2-twirp-notfound

**phase: restore**

```
L123  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"fault-v2-twirp-notfound-6256","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 404 {"code":"not_found","msg":"cache entry not found"}
```

### fault-v2-http-500

**phase: restore**

```
L124  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"fault-v2-http-500-31272","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 500 {"code":"internal","msg":"boom"}
L125  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"fault-v2-http-500-31272","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 500 {"code":"internal","msg":"boom"}
L126  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"fault-v2-http-500-31272","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 500 {"code":"internal","msg":"boom"}
L127  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"fault-v2-http-500-31272","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 500 {"code":"internal","msg":"boom"}
L128  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"fault-v2-http-500-31272","version":"b34e6f1cc07875b8b978f21e92cbe8337fea885819e74e1d75a2c78c7a523960"}
      <-- 500 {"code":"internal","msg":"boom"}
```

### F1-buildx-gha-envonly

**phase: miss**

```
L129  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-F1-1-f921bd05&version=693bb7016429d803…
      <-- 204 <0 bytes>
L130  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
L131  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:54fd6036a4b12e44b41837628e907cac1bf20e50c3a9e526d337a915b62b2897&version=693bb7016429d803…
      <-- 204 <0 bytes>
L132  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:54fd6036a4b12e44b41837628e907cac1bf20e50c3a9e526d337a915b62b2897","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":863311}
L133  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/863311
      req  <6293532 B binary>
      <-- 204 <0 bytes>
L134  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/863311
      req  {"size":6293532}
      <-- 204 <0 bytes>
L135  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:7c32ca3a6387691f17d711a8d1635c4e2542583f12f50873bf3537ce299aa2d8&version=693bb7016429d803…
      <-- 204 <0 bytes>
L136  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:7c32ca3a6387691f17d711a8d1635c4e2542583f12f50873bf3537ce299aa2d8","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":198973}
L137  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/198973
      req  <4195735 B binary>
      <-- 204 <0 bytes>
L138  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/198973
      req  {"size":4195735}
      <-- 204 <0 bytes>
L139  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:da36faae202c7838a911ccc981942be12dec9696d59c8aa4021b9d1f5af4c848&version=693bb7016429d803…
      <-- 204 <0 bytes>
L140  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:da36faae202c7838a911ccc981942be12dec9696d59c8aa4021b9d1f5af4c848","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":497512}
L141  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/497512
      req  <116 B binary>
      <-- 204 <0 bytes>
L142  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/497512
      req  {"size":116}
      <-- 204 <0 bytes>
L143  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-F1-1-f921bd05#&version=693bb7016429d803…
      <-- 204 <0 bytes>
L144  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"index-F1-1-f921bd05#1","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":375475}
L145  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/375475
      req  <2306 B binary>
      <-- 204 <0 bytes>
L146  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/375475
      req  {"size":2306}
      <-- 204 <0 bytes>
```

### F2-buildx-gha-envonly-v2flag

**phase: miss**

```
L147  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-F2-1-f921bd05&version=693bb7016429d803…
      <-- 204 <0 bytes>
L148  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
L149  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:6d6ae5315d5ccc074f1ec85bc671afcc164d59c7348f3cab12413bcd2d6aa8c9&version=693bb7016429d803…
      <-- 204 <0 bytes>
L150  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:6d6ae5315d5ccc074f1ec85bc671afcc164d59c7348f3cab12413bcd2d6aa8c9","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":586730}
L151  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/586730
      req  <6293531 B binary>
      <-- 204 <0 bytes>
L152  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/586730
      req  {"size":6293531}
      <-- 204 <0 bytes>
L153  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:7db0c3dd0bee1b4918e130c178c697a36be329d586ad8b3301c7570fc5276881&version=693bb7016429d803…
      <-- 204 <0 bytes>
L154  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:7db0c3dd0bee1b4918e130c178c697a36be329d586ad8b3301c7570fc5276881","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":194090}
L155  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/194090
      req  <116 B binary>
      <-- 204 <0 bytes>
L156  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/194090
      req  {"size":116}
      <-- 204 <0 bytes>
L157  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:c3bed923a3dce0e203a08b51f4bb7e2723004227f3e2614c9d4fcb92e9f662e8&version=693bb7016429d803…
      <-- 204 <0 bytes>
L158  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:c3bed923a3dce0e203a08b51f4bb7e2723004227f3e2614c9d4fcb92e9f662e8","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":960991}
L159  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/960991
      req  <4195738 B binary>
      <-- 204 <0 bytes>
L160  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/960991
      req  {"size":4195738}
      <-- 204 <0 bytes>
L161  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-F2-1-f921bd05#&version=693bb7016429d803…
      <-- 204 <0 bytes>
L162  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"index-F2-1-f921bd05#1","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":112972}
L163  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/112972
      req  <2306 B binary>
      <-- 204 <0 bytes>
L164  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/112972
      req  {"size":2306}
      <-- 204 <0 bytes>
```

### G1-buildx-0.36.1-envonly-v2flag

**phase: miss**

```
L165  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"index-G1-1-f921bd05","restore_keys":["index-G1-1-f921bd05"],"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L166  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","restore_keys":["buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78"],"version":"693bb7016429d80
      <-- 200 {"ok":true,"signed_download_url":"http://host.docker.internal:8721/blob/v2-27c56a35-4603-4c72-81e2-774b054d7623.tzst?sig=stand-in","matched_key":"buildkit-blob-1-sha256:3f26bc2dec0
L167  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:4517ab0234aa2fb506e780a1e4e67a761696350caac086f6299a18e6d90de4f9","restore_keys":["buildkit-blob-1-sha256:4517ab0234aa2fb506e780a1e4e67a761696350caac086f6299a18e6d90de4f9"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L168  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:4517ab0234aa2fb506e780a1e4e67a761696350caac086f6299a18e6d90de4f9","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?sig=stand-in&se=2030-01-01"}
L169  PUT {signed url}/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L170  PUT {signed url}/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L171  PUT {signed url}/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L172  PUT {signed url}/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L173  PUT {signed url}/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1435 B binary>
      <-- 201 <0 bytes>
L174  PUT {signed url}/v2-5e3e420f-6dcc-4ebd-ac80-be6a0e9a7ab9.tzst?comp=blocklist
      req  <xml 587B>
      <-- 201 <0 bytes>
L175  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:4517ab0234aa2fb506e780a1e4e67a761696350caac086f6299a18e6d90de4f9","size_bytes":4195739,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L176  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:4f52061d6868178d48dffeeb3743a3a0cbcfc24188ac68085b8f2d15381a486a","restore_keys":["buildkit-blob-1-sha256:4f52061d6868178d48dffeeb3743a3a0cbcfc24188ac68085b8f2d15381a486a"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L177  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:4f52061d6868178d48dffeeb3743a3a0cbcfc24188ac68085b8f2d15381a486a","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?sig=stand-in&se=2030-01-01"}
L178  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L179  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L180  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L181  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L182  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L183  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <1048576 B binary>
      <-- 201 <0 bytes>
L184  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?blockid=<64-char+base64+block+id>&comp=block
      req  <2072 B binary>
      <-- 201 <0 bytes>
L185  PUT {signed url}/v2-984c9a22-306a-4237-aad5-b60baa8aa194.tzst?comp=blocklist
      req  <xml 797B>
      <-- 201 <0 bytes>
L186  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:4f52061d6868178d48dffeeb3743a3a0cbcfc24188ac68085b8f2d15381a486a","size_bytes":6293528,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L187  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"buildkit-blob-1-sha256:64150da064309f973c639630b6a46d549f2ee9a168c668676f2caf63ba7e8890","restore_keys":["buildkit-blob-1-sha256:64150da064309f973c639630b6a46d549f2ee9a168c668676f2caf63ba7e8890"],"version":"693bb7016429d80
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L188  POST twirp CacheService/CreateCacheEntry
      req  {"key":"buildkit-blob-1-sha256:64150da064309f973c639630b6a46d549f2ee9a168c668676f2caf63ba7e8890","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-38b63586-298b-4f90-a472-29a05a504379.tzst?sig=stand-in&se=2030-01-01"}
L189  PUT {signed url}/v2-38b63586-298b-4f90-a472-29a05a504379.tzst
      req  <116 B binary>
      <-- 201 <0 bytes>
L190  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"buildkit-blob-1-sha256:64150da064309f973c639630b6a46d549f2ee9a168c668676f2caf63ba7e8890","size_bytes":116,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
L191  POST twirp CacheService/GetCacheEntryDownloadURL
      req  {"key":"index-G1-1-f921bd05#","restore_keys":["index-G1-1-f921bd05#"],"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":false,"signed_download_url":"","matched_key":""}
L192  POST twirp CacheService/CreateCacheEntry
      req  {"key":"index-G1-1-f921bd05#1","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"signed_upload_url":"http://host.docker.internal:8721/blob/v2-5b342ff4-4115-4595-bd26-42dfc21ef39f.tzst?sig=stand-in&se=2030-01-01"}
L193  PUT {signed url}/v2-5b342ff4-4115-4595-bd26-42dfc21ef39f.tzst
      req  <2306 B binary>
      <-- 201 <0 bytes>
L194  POST twirp CacheService/FinalizeCacheEntryUpload
      req  {"key":"index-G1-1-f921bd05#1","size_bytes":2306,"version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 200 {"ok":true,"entry_id":"424242"}
```

### G2-buildx-0.36.1-envonly-noflag

**phase: miss**

```
L195  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-G2-1-f921bd05&version=693bb7016429d803…
      <-- 204 <0 bytes>
L196  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78&version=693bb7016429d803…
      <-- 200 {"cacheKey":"buildkit-blob-1-sha256:3f26bc2dec0b515f1c2818f6e13a8f1da1f88179a008445d4e587233386bff78","scope":"refs/heads/main","archiveLocation":"http://host.docker.internal:8721/
L197  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:50294384252ee5e67abc598434b5905f1b86038db37c4cc678b89670d2e2976d&version=693bb7016429d803…
      <-- 204 <0 bytes>
L198  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:50294384252ee5e67abc598434b5905f1b86038db37c4cc678b89670d2e2976d","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":964394}
L199  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/964394
      req  <116 B binary>
      <-- 204 <0 bytes>
L200  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/964394
      req  {"size":116}
      <-- 204 <0 bytes>
L201  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:56fe08106c630c5b6627ce73c3dc6178b0d641dd6f4a6dc567ec510089efb7ea&version=693bb7016429d803…
      <-- 204 <0 bytes>
L202  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:56fe08106c630c5b6627ce73c3dc6178b0d641dd6f4a6dc567ec510089efb7ea","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":824938}
L203  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/824938
      req  <6293527 B binary>
      <-- 204 <0 bytes>
L204  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/824938
      req  {"size":6293527}
      <-- 204 <0 bytes>
L205  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=buildkit-blob-1-sha256:d838019cf337083d29a91ecd5f4098ce69041247fd693ee32f8d22fe2676b771&version=693bb7016429d803…
      <-- 204 <0 bytes>
L206  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"buildkit-blob-1-sha256:d838019cf337083d29a91ecd5f4098ce69041247fd693ee32f8d22fe2676b771","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":294628}
L207  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/294628
      req  <4195739 B binary>
      <-- 204 <0 bytes>
L208  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/294628
      req  {"size":4195739}
      <-- 204 <0 bytes>
L209  GET {ACTIONS_CACHE_URL}/_apis/artifactcache/cache?keys=index-G2-1-f921bd05#&version=693bb7016429d803…
      <-- 204 <0 bytes>
L210  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches
      req  {"key":"index-G2-1-f921bd05#1","version":"693bb7016429d80366022f036f84856888c9f13e00145f5f6f4dce303a38d6f2"}
      <-- 201 {"cacheId":358378}
L211  PATCH {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358378
      req  <2305 B binary>
      <-- 204 <0 bytes>
L212  POST {ACTIONS_CACHE_URL}/_apis/artifactcache/caches/358378
      req  {"size":2305}
      <-- 204 <0 bytes>
```
