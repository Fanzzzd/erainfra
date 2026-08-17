import { randomUUID } from "node:crypto";

// AgentGateway is the self-controlled control channel that replaces dumbpipe: portless agents on
// remote (NAT'd) boxes dial OUT to the hub over a WebSocket and stay connected; the hub addresses
// them by id and pushes typed commands (deploy a container, operate, ping), awaiting their reply. No inbound
// port on the agent, no third-party relay — just our WSS, which rides the hub's Cloudflare tunnel.
//
// Protocol (JSON per frame):
//   agent -> hub: {type:'hello', agentId, version, roles}   (on connect)
//                 {type:'reply', id, ok, output?, error?}    (answering a cmd)
//                 {type:'heartbeat'}                          (keepalive)
//   hub  -> agent: {type:'cmd', id, ...AgentCommand}

export interface AgentOperation {
  name: string;
  args: Record<string, string>;
}

export interface AgentService {
  name: string;
  image: string;
  args: string[];
  env: Record<string, string>;
  port?: number;
  route?: string;
}

// Exhaustive hub-to-node protocol. In particular, there is no raw argv command: host operations
// cross the wire only as AgentOperation and are resolved by the node's allowlist.
export type AgentCommand =
  | { cmd: "ping" }
  | { cmd: "operate"; operation: AgentOperation }
  | {
      cmd: "deploy";
      image: string;
      name: string;
      args: string[];
      env: Record<string, string>;
      port?: number;
    }
  | { cmd: "deployApp"; app: string; services: AgentService[] }
  | { cmd: "serve"; app: string; port: number }
  | { cmd: "meshShare"; name: string; port: number }
  | { cmd: "meshConnect"; name: string; ticket: string; port: number }
  | { cmd: "meshDrop"; name: string }
  | {
      cmd: "build";
      repoUrl?: string;
      ref?: string;
      tarUrl?: string;
      dir?: string;
      registry: string;
      tag: string;
      hubBase: string;
    }
  | { cmd: "spec"; repoUrl?: string; ref?: string; tarUrl?: string };

// Minimal socket surface so the gateway is testable without a real WebSocket.
export interface AgentSocket {
  send(data: string): void;
  close(): void;
}

export interface AgentInfo {
  id: string;
  version: string | null;
  roles: string[];
  connectedAt: string;
}

export interface AgentReply {
  ok: boolean;
  output?: string;
  error?: string;
}

// Pure: parse an inbound agent frame; null on malformed or missing type.
export function parseAgentMessage(raw: string): Record<string, unknown> | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m === "object" && typeof (m as { type?: unknown }).type === "string"
      ? m
      : null;
  } catch {
    return null;
  }
}

interface Entry {
  socket: AgentSocket;
  info: AgentInfo;
}
interface Pending {
  resolve: (r: AgentReply) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AgentGateway {
  private byId = new Map<string, Entry>();
  private idOf = new Map<AgentSocket, string>();
  private pending = new Map<string, Pending>();
  private lastSeen = new Map<string, number>(); // agentId -> last inbound frame time (liveness)
  private disconnectListeners: Array<(agentId: string) => void> = [];
  private connectListeners: Array<(agentId: string) => void> = [];

  // Notify when a registered agent's socket closes (its presence is gone). Drives auto-failover.
  onDisconnect(cb: (agentId: string) => void): void {
    this.disconnectListeners.push(cb);
  }

  // Notify on every agent hello (fresh connect OR reconnect). Drives state rehydration — an agent
  // restart loses its in-memory app registry while its containers keep running.
  onConnect(cb: (agentId: string) => void): void {
    this.connectListeners.push(cb);
  }

  list(): AgentInfo[] {
    return [...this.byId.values()].map((e) => ({ ...e.info }));
  }

  get(id: string): AgentInfo | undefined {
    const e = this.byId.get(id);
    return e ? { ...e.info } : undefined;
  }

  // Feed an inbound frame from a connected socket. Handles hello (register), reply (resolve a
  // pending command), heartbeat (keepalive).
  onMessage(socket: AgentSocket, raw: string): void {
    const m = parseAgentMessage(raw);
    if (!m) return;
    // Any inbound frame (reply, heartbeat, hello) counts as liveness for the reaper.
    const known = this.idOf.get(socket);
    if (known) this.lastSeen.set(known, Date.now());
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
          this.idOf.delete(prev.socket);
        }
        const info: AgentInfo = {
          id,
          version: m.version != null ? String(m.version) : null,
          roles: Array.isArray(m.roles) ? m.roles.map(String) : [],
          connectedAt: new Date().toISOString(),
        };
        this.byId.set(id, { socket, info });
        this.idOf.set(socket, id);
        this.lastSeen.set(id, Date.now());
        for (const cb of this.connectListeners) {
          try {
            cb(id);
          } catch {
            /* listener's problem */
          }
        }
        break;
      }
      case "reply": {
        const p = this.pending.get(String(m.id ?? ""));
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        p.resolve({
          ok: !!m.ok,
          output: m.output != null ? String(m.output) : undefined,
          error: m.error != null ? String(m.error) : undefined,
        });
        break;
      }
      // heartbeat: presence only for now (the socket staying open is the signal).
    }
  }

  onClose(socket: AgentSocket): void {
    this.removeSocket(socket);
  }

  // Remove an agent and notify disconnect listeners (drives failover). Used by both a clean socket
  // close and the reaper; idempotent (a later close of the same socket is a no-op).
  private removeSocket(socket: AgentSocket): void {
    const id = this.idOf.get(socket);
    this.idOf.delete(socket);
    let lost = false;
    if (id && this.byId.get(id)?.socket === socket) {
      this.byId.delete(id);
      this.lastSeen.delete(id);
      lost = true;
    }
    if (lost && id)
      for (const cb of this.disconnectListeners) {
        try {
          cb(id);
        } catch {
          /* listener error must not break close */
        }
      }
  }

  // Close + remove any agent that hasn't sent a frame within maxIdleMs (a silently-dead NAT mapping).
  // The removal fires disconnect listeners, so this is what makes failover trigger on real network death
  // rather than only on a clean socket close.
  reapStale(maxIdleMs: number): void {
    const now = Date.now();
    // False positive: the spread is a snapshot, not a conversion. removeSocket() below fires
    // disconnectListeners, and a listener is free to re-register the agent — which would insert into
    // this.byId mid-iteration. A live Map iterator visits entries added during iteration, and the
    // new entry has no lastSeen yet, so it would be reaped on the spot by the very loop that caused
    // the reconnect. Iterate the snapshot.
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const [id, entry] of [...this.byId]) {
      if (now - (this.lastSeen.get(id) ?? 0) > maxIdleMs) {
        try {
          entry.socket.close();
        } catch {
          /* already gone */
        }
        this.removeSocket(entry.socket);
      }
    }
  }

  // Send a command to an agent and resolve with its reply (or reject on timeout / not connected).
  send(agentId: string, cmd: AgentCommand, timeoutMs = 30_000): Promise<AgentReply> {
    const entry = this.byId.get(agentId);
    if (!entry) return Promise.reject(new Error(`agent not connected: ${agentId}`));
    const id = randomUUID();
    return new Promise<AgentReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("agent command timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        entry.socket.send(JSON.stringify({ type: "cmd", id, ...cmd }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }
}

// Shared singleton: the WS route (server.ts) feeds it sockets; the tRPC router (router.ts) drives it.
export const agentGateway = new AgentGateway();
