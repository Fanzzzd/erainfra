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
curl -fsSL https://<hub>/mesh-node.sh | sh -s -- share 5000 # → a registry TICKET for the other boxes
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
# point at the store over the mesh, then build+push:
curl -fsSL https://<hub>/mesh-node.sh | sh -s -- connect <registry-ticket> 5000
curl -fsSL https://<hub>/image.sh     | sh -s -- ship ./myapp myapp:v1
```

`ship` = `docker build -t 127.0.0.1:5000/myapp:v1 ./myapp` then `docker push`. (The build box needs
Docker or podman; building is the heavy step that's fine on a capable box.)

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
- **Verified:** the store + mesh transport are proven end-to-end (zot ← oras push/pull through a real
  mesh link, byte-for-byte). The `docker build/push/pull/run` steps are standard; run them on your
  boxes (the dev box here has no working Docker daemon).
