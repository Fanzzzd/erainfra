// The data plane: how inbound HTTP for `<app>.<domain>` reaches a container on a NAT'd node. The
// agent dials a SECOND outbound WS to the hub (`/data`, separate from the control channel so a long
// deploy never blocks traffic). The hub multiplexes many concurrent HTTP requests over that one
// socket via per-request stream ids — the control channel's one-command-at-a-time model is wrong for
// a proxy (head-of-line blocking + no response correlation), so this is deliberately different.
//
// Protocol (JSON per frame; body base64). ponytail: buffered bodies, JSON+base64 — switch to binary
// framing with chunked REQ_BODY/RESP_BODY when streaming or >10MB bodies matter.
//   agent -> hub: {type:'hello', agentId}                          (on connect)
//                 {type:'resp', id, status, headers, body}         (answering a req)
//                 {type:'err',  id, error}                         (upstream failed)
//   hub  -> agent: {type:'req', id, app, method, path, headers, body}
import { randomUUID } from "node:crypto";

export interface DataSocket {
  send(data: string): void;
  close(): void;
}

export interface ProxyRequest {
  method: string;
  path: string; // path + query
  headers: Record<string, string>;
  body: Buffer;
}
export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export const MAX_BODY = 10 * 1024 * 1024; // 10MB proxied-body cap (v1) → 413 above
export const MAX_INFLIGHT_PER_NODE = 256; // shed (503) above; bounds hub memory + node read loop
const PROXY_TIMEOUT_MS = 30_000; // independent of the server's requestTimeout:0 (long deploys)

// Hop-by-hop headers (RFC 7230 §6.1) must not be forwarded by a proxy.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const APP_LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;

// `<app>.<baseDomain>` -> app, or null if this host isn't an app subdomain (so the hub's own host,
// IPs, and anything else fall through to normal routing). Exact suffix match, single label only.
export function appFromHost(
  host: string | undefined,
  baseDomain: string | undefined,
): string | null {
  if (!host || !baseDomain) return null;
  const h = host.toLowerCase().split(":")[0]; // strip port
  const suffix = "." + baseDomain.toLowerCase();
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  return APP_LABEL.test(label) ? label : null;
}

// Strip hop-by-hop + reject header injection, then set forwarding headers. Returns a clean header map
// safe to hand to the upstream. Pure so it's unit-testable.
export function sanitizeRequestHeaders(
  headers: Record<string, string | string[] | undefined>,
  opts: { host: string; clientIp: string; proto: string },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key) || key.startsWith("x-forwarded-")) continue; // we set X-Forwarded-* ourselves
    const val = Array.isArray(v) ? v.join(", ") : v;
    if (/[\r\n]/.test(key) || /[\r\n]/.test(val)) continue; // drop CRLF-injection attempts
    out[k] = val;
  }
  out["X-Forwarded-Host"] = opts.host;
  out["X-Forwarded-For"] = opts.clientIp;
  out["X-Forwarded-Proto"] = opts.proto;
  return out;
}

interface DataEntry {
  socket: DataSocket;
  inflight: Set<string>;
}
interface Pending {
  resolve: (r: ProxyResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  node: string;
}

export class DataGateway {
  private byId = new Map<string, DataEntry>();
  private idOf = new Map<DataSocket, string>();
  private pending = new Map<string, Pending>();
  private lastSeen = new Map<string, number>(); // node -> last inbound frame/ping time (liveness)

  isConnected(node: string): boolean {
    return this.byId.has(node);
  }

  // Mark a node's data socket alive (called on any inbound frame and on WS pings). Lets the reaper
  // drop a silently-dead data socket instead of routing requests into a black hole (30s timeouts).
  touch(socket: DataSocket): void {
    const id = this.idOf.get(socket);
    if (id) this.lastSeen.set(id, Date.now());
  }

  // Close + drop any data socket idle past maxIdleMs (so isConnected() stops returning true for a dead
  // node and the proxy fast-fails / falls to failover instead of timing out).
  reapStale(maxIdleMs: number): void {
    const now = Date.now();
    for (const [id, entry] of [...this.byId]) {
      if (now - (this.lastSeen.get(id) ?? 0) > maxIdleMs) {
        try {
          entry.socket.close();
        } catch {
          /* already gone */
        }
        this.onClose(entry.socket);
      }
    }
  }

  connectedNodes(): string[] {
    return [...this.byId.keys()];
  }

  onMessage(socket: DataSocket, raw: string): void {
    let m: Record<string, unknown> | null;
    try {
      const j = JSON.parse(raw);
      m = j && typeof j === "object" ? j : null;
    } catch {
      m = null;
    }
    if (!m || typeof m.type !== "string") return;
    this.touch(socket); // any inbound frame counts as liveness
    switch (m.type) {
      case "hello": {
        const id = String(m.agentId ?? "").trim();
        if (!id) return;
        const prev = this.byId.get(id);
        if (prev && prev.socket !== socket) {
          try {
            prev.socket.close();
          } catch {
            /* gone */
          }
          this.rejectSocket(prev.socket, "replaced by new data connection");
        }
        this.byId.set(id, { socket, inflight: new Set() });
        this.idOf.set(socket, id);
        this.lastSeen.set(id, Date.now());
        break;
      }
      case "resp": {
        const p = this.pending.get(String(m.id ?? ""));
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        this.byId.get(p.node)?.inflight.delete(String(m.id));
        p.resolve({
          status: Number(m.status) || 502,
          headers: (m.headers && typeof m.headers === "object" ? m.headers : {}) as Record<
            string,
            string
          >,
          body: Buffer.from(typeof m.body === "string" ? m.body : "", "base64"),
        });
        break;
      }
      case "err": {
        const p = this.pending.get(String(m.id ?? ""));
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        this.byId.get(p.node)?.inflight.delete(String(m.id));
        p.reject(new Error(String(m.error ?? "upstream error")));
        break;
      }
    }
  }

  onClose(socket: DataSocket): void {
    const id = this.idOf.get(socket);
    this.rejectSocket(socket, "node disconnected"); // fail in-flight requests fast (no client hang)
    this.idOf.delete(socket);
    if (id && this.byId.get(id)?.socket === socket) {
      this.byId.delete(id);
      this.lastSeen.delete(id);
    }
  }

  // Reject every pending request routed to a given socket's node (B2: don't let clients hang on
  // disconnect — they should get a fast 502).
  private rejectSocket(socket: DataSocket, reason: string): void {
    const node = this.idOf.get(socket);
    for (const [id, p] of [...this.pending]) {
      if (node && p.node !== node) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }

  // Send one HTTP request to a node over its data socket and await the response. The agent resolves
  // app->port from its OWN deploy state and fetches loopback — the hub never supplies a host:port, so
  // a compromised hub frame can't turn the agent into an SSRF proxy.
  proxy(node: string, app: string, req: ProxyRequest): Promise<ProxyResponse> {
    const entry = this.byId.get(node);
    if (!entry) return Promise.reject(new Error(`node not connected: ${node}`));
    if (entry.inflight.size >= MAX_INFLIGHT_PER_NODE)
      return Promise.reject(new Error("node at capacity"));
    if (req.body.length > MAX_BODY) return Promise.reject(new Error("body too large"));
    const id = randomUUID();
    return new Promise<ProxyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        entry.inflight.delete(id);
        reject(new Error("upstream timed out"));
      }, PROXY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, node });
      entry.inflight.add(id);
      try {
        entry.socket.send(
          JSON.stringify({
            type: "req",
            id,
            app,
            method: req.method,
            path: req.path,
            headers: req.headers,
            body: req.body.toString("base64"),
          }),
        );
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        entry.inflight.delete(id);
        reject(e as Error);
      }
    });
  }
}

export const dataGateway = new DataGateway();
