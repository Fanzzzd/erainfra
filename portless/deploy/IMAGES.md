# Build/deploy split — build on a strong box, deploy on a weak one

Some boxes can't build (low memory/CPU) — they can only run. So split the two: **build once on a
capable box, store the image on infra you own, pull + run on the weak boxes.** No Docker Hub, no
third-party — the store is your own VPS/fixed box (and your S3 when you wire it).

```
  BUILD box (capable)        STORE (your VPS/box; S3 later)        DEPLOY box (weak)
    docker build               zot OCI registry  ──▶ S3 (optional)   docker pull
    docker push ───────────────▶  :5000  (the store)        ◀─────── docker run
            └──────────── reached over the mesh (127.0.0.1, no public IP) ──────────┘
```

The store is just an HTTP blob store, so it needs **no Docker to run** — a single `zot` binary. It's
reachable over the mesh (the same iroh links as everything else), so no box needs a public IP, and
because Docker treats `127.0.0.1:*` as an insecure registry automatically, the mesh path needs **no
daemon config**.

## 1. Stand up the store (on your VPS / capable box)

```bash
curl -fsSL https://<hub>/registry.sh | sh -s -- up 5000     # downloads zot, runs it on 127.0.0.1:5000
```

**Enrolled nodes need no tickets** — the platform wires the store over the mesh for you:

```bash
portless link <store-node>:5000 <build-node>    # surface the store at 127.0.0.1:5000 there
# or fully automatic: set PORTLESS_REGISTRY_NODE=<store-node> on the hub, and every deploy
# wires build/deploy nodes to the registry itself (links persist + self-heal).
```

To back it with **your S3** instead of local disk, set these before `up` (creds from the AWS env):

```bash
export PORTLESS_REGISTRY_S3_BUCKET=my-images PORTLESS_REGISTRY_S3_REGION=us-east-1
export AWS_ACCESS_KEY_ID=… AWS_SECRET_ACCESS_KEY=…
# optional S3-compatible endpoint (MinIO etc.): PORTLESS_REGISTRY_S3_ENDPOINT=https://…
curl -fsSL https://<hub>/registry.sh | sh -s -- up 5000
```

## 2. Build + push (on the capable build box)

```bash
# enrolled node: the mesh link above already surfaced the store at 127.0.0.1:5000. Just ship:
curl -fsSL https://<hub>/image.sh     | sh -s -- ship ./myapp myapp:v1
# (un-enrolled box? run dumbpipe by hand: `dumbpipe listen-tcp --host 127.0.0.1:5000` on the store,
#  `dumbpipe connect-tcp --addr 127.0.0.1:5000 <ticket>` here.)
```

`ship` **auto-detects** how to build, then pushes:
- a `Dockerfile` in the context → `docker build`;
- no Dockerfile → **Nixpacks** (a single prebuilt binary that detects Node/Python/Go/Rust/… and
  generates the build itself — the "drag in source, no Dockerfile needed" Railway trick).

The build box needs Docker or podman (Nixpacks shells `docker` specifically; for podman, provide a
Dockerfile). Building is the heavy step that's fine on a capable box.

## 3. Pull + run (on the weak deploy box)

```bash
curl -fsSL https://<hub>/mesh-node.sh | sh -s -- connect <registry-ticket> 5000
curl -fsSL https://<hub>/image.sh     | sh -s -- run myapp:v1 -d --name myapp -p 8080:8080
```

`run` = `docker pull 127.0.0.1:5000/myapp:v1` then `docker run …`. The weak box only **runs** a
container — far lighter than building one — so it doesn't need the build toolchain.

## Notes

- **Container runtime:** `ship`/`run` use `docker` by default; set `DOCKER=podman` to use podman.
  The store (`registry.sh`) itself needs neither.
- **Without the mesh:** if your store box has a public IP/domain, point `PORTLESS_REGISTRY` straight
  at it (`export PORTLESS_REGISTRY=registry.example.com`) and give zot TLS, or add it to the
  daemon's `insecure-registries`. The mesh path avoids all of that.
- **macOS / Docker Desktop build box (gotchas, Linux build boxes are unaffected):**
  - Port **5000 is taken by AirPlay Receiver** (ControlCenter) on macOS — it'll silently intercept the
    registry. Use another port: `registry.sh up 5005` and `PORTLESS_REGISTRY=127.0.0.1:5005`.
  - Docker Desktop runs the daemon **in a VM**, so a *host-binary* zot on `127.0.0.1` isn't reachable
    from the daemon for push/pull. Either run the store **as a container** (`docker run -d -p
    5005:5000 registry:2` — its published port lives in the VM's netns, so `127.0.0.1:5005` resolves
    for both push and pull and stays auto-insecure/HTTP), or push to `host.docker.internal:5005` after
    adding it to the daemon's `insecure-registries`. On a native Linux build box the host-binary zot on
    `127.0.0.1:5000` just works — dockerd shares the host loopback.
- **Verified end-to-end (with Docker):** Nixpacks build of a no-Dockerfile app → push → registry
  catalog → `agents.deploy` over the spine → agent `docker pull`+`run` → the container served HTTP.
  Separately, the store + mesh transport are proven byte-for-byte (zot ← oras over a real mesh link).
