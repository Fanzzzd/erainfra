// End-to-end check of the real MeshManager: share a local TCP echo "service" on the iroh mesh,
// connect to it from another local port by ticket, and assert byte-for-byte transparent TCP.
// This is the portless integration of Direction B (iroh/dumbpipe). On this Mac the data rides
// n0's relay (the VPN blocks UDP hole-punch), so it proves CORRECTNESS, not peak latency.
// Run: node --experimental-strip-types prototypes/relay-experiments/verify-mesh.ts
import net from "node:net";
import { MeshManager } from "../../apps/api/src/runtime/mesh.ts";

const ECHO_PORT = 7100;
const LOCAL_PORT = 7200;

function startEcho(port: number): Promise<net.Server> {
  return new Promise((res) => {
    const s = net.createServer((sock) => sock.pipe(sock)); // dumb echo
    s.listen(port, "127.0.0.1", () => res(s));
  });
}

function roundtrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    const c = net.connect(port, "127.0.0.1", () => c.write(payload));
    c.on("data", (d) => {
      chunks.push(d);
      n += d.length;
      if (n >= payload.length) {
        c.end();
        resolve(Buffer.concat(chunks));
      }
    });
    c.on("error", reject);
    setTimeout(() => reject(new Error("roundtrip timeout")), 20_000);
  });
}

const mesh = new MeshManager();
const echo = await startEcho(ECHO_PORT);
try {
  console.log(`sharing 127.0.0.1:${ECHO_PORT} on the mesh (db side)...`);
  const link = await mesh.share("db", ECHO_PORT);
  console.log(`  ticket: ${link.ticket.slice(0, 28)}… (${link.ticket.length} chars)`);

  console.log(`connecting that ticket to local :${LOCAL_PORT} (backend side)...`);
  await mesh.connect("backend", link.ticket, LOCAL_PORT);

  const N = 50;
  let ok = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    const payload = Buffer.from(`msg-${i}-${"x".repeat(64)}`);
    const echoed = await roundtrip(LOCAL_PORT, payload);
    if (!echoed.equals(payload)) throw new Error(`mismatch at ${i}: ${echoed.toString()}`);
    ok++;
  }
  const ms = (performance.now() - t0) / N;
  console.log(`correctness: ${ok}/${N} byte-for-byte ✅`);
  console.log(`latency: ~${ms.toFixed(1)} ms/roundtrip through iroh (relay path on this Mac)`);
  console.log(
    `links live: ${mesh
      .list()
      .map((l) => `${l.name}(${l.role}:${l.port})`)
      .join(", ")}`,
  );
} finally {
  await mesh.stopAll();
  echo.close();
  console.log("cleaned up — no mesh processes left.");
}
