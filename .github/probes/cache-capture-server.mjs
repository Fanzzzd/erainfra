// A throwaway Actions cache endpoint that answers correctly and records who
// called it. It exists to measure one thing that no capture against a stand-in
// can answer -- which environment a real runner hands a real step -- so it
// speaks just enough of both generations for a client to complete a restore
// and it stores nothing.
//
// The responses are the ones ADR 0007's capture measured as a clean miss, not
// invented ones: v1 answers 204 and NEVER 404
// (docs/research/actions-cache-protocol-capture.md L001, L121), and v2 answers
// 200 {"ok":false} (L007). A wrong-shaped miss produces a warning and 30
// seconds of backoff instead of the silent miss this probe needs, which would
// change the very behaviour being measured.
//
// Nothing here is a cache: apps/cache-service is the implementation. This file
// is an instrument, it is never deployed, and no workflow other than
// cache-env-probe.yml may use it.

import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";

const V1_MARKER = "/_apis/artifactcache/";
const V2_MARKER = "/twirp/github.actions.results.api.v1.CacheService/";

const logPath = process.env.PROBE_LOG;
const urlFile = process.env.PROBE_URL_FILE;
if (logPath === undefined || logPath.length === 0) {
  console.error("PROBE_LOG is required: the capture log is the whole output of this probe.");
  process.exit(2);
}

// The request line and nothing from the request that could be a secret. Two
// things in a cache request are, and this log is printed into a job summary:
//
//   - the bearer credential. A client sends the runner's own
//     ACTIONS_RUNTIME_TOKEN, so its PRESENCE is recorded and its value never
//     leaves the process.
//   - the cache key. v1 carries it in the `keys=` query parameter and v2 in
//     the request body, and a key is routinely a lockfile hash, a branch name
//     or a path from a private repository. So the QUERY STRING IS DROPPED
//     before anything is written, and the body is drained without being read.
//     Only the pathname is recorded -- which is all the tier prefix and the
//     generation marker live in.
function record(entry) {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function generationOf(path) {
  if (path.includes(V1_MARKER)) return "v1";
  if (path.includes(V2_MARKER)) return "v2";
  return "other";
}

function respond(response, status, body) {
  if (body === undefined) {
    // A 204 carries no body and no content-type. actions/cache reads the status
    // alone here, and a 204 that arrives with a JSON content-type is a shape no
    // real service sends.
    response.writeHead(status);
    response.end();
    return status;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(payload)),
  });
  response.end(payload);
  return status;
}

function answer(request, response, generation) {
  if (generation === "v1") {
    // The restore probe. A miss is 204 with no body; 404 is what makes
    // actions/cache print a warning instead (L121).
    if (request.method === "GET") return respond(response, 204);
    // A reserve, which only a save reaches. Refusing it with 409 is the shape
    // "another job already reserved this key" takes, so a save that gets this
    // far stops without uploading and without failing the step.
    return respond(response, 409, { message: "the probe does not store cache entries" });
  }

  if (generation === "v2") {
    // Both calls a restore makes -- GetCacheEntryDownloadURL and, from a save,
    // CreateCacheEntry -- share the miss shape: the twirp call succeeds and
    // `ok` is false (L007, L078). Every other RPC gets the same answer, which
    // is the one that keeps a client quiet rather than the one that is
    // strictly correct; this probe is measuring an environment, not conforming
    // to a protocol.
    return respond(response, 200, { ok: false });
  }

  // Anything else is a client reaching for something this probe does not
  // implement -- the artifact service under the same ACTIONS_RESULTS_URL is the
  // one that matters -- and it is recorded rather than answered, because
  // pretending would hide exactly the collision worth knowing about.
  return respond(response, 404, { message: "not a cache endpoint" });
}

const server = createServer((request, response) => {
  // Origin-form, so this is already path-and-query rather than a full URL, and
  // splitting at the first `?` is what leaves the cache key on the floor.
  // `query` is still reported, because "a restore arrived and it carried keys"
  // is evidence and the keys themselves are not.
  const target = request.url ?? "";
  const separator = target.indexOf("?");
  const path = separator < 0 ? target : target.slice(0, separator);
  const generation = generationOf(path);
  // The body is drained but never read: a v2 request carries the cache key,
  // and the point of this probe is the environment, not the keys.
  request.resume();
  const status = answer(request, response, generation);
  record({
    method: request.method,
    path,
    query: separator < 0 ? "absent" : "present",
    generation,
    status,
    authorization: request.headers.authorization === undefined ? "absent" : "present",
    userAgent: request.headers["user-agent"] ?? "",
  });
});

server.listen(Number(process.env.PROBE_PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/`;
  if (urlFile !== undefined && urlFile.length > 0) {
    writeFileSync(urlFile, base);
  }
  console.log(base);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
