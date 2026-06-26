import { randomUUID } from 'node:crypto';

// AgentGateway is the self-controlled control channel that replaces dumbpipe: portless agents on
// remote (NAT'd) boxes dial OUT to the hub over a WebSocket and stay connected; the hub addresses
// them by id and pushes commands (deploy a container, exec, ping), awaiting their reply. No inbound
// port on the agent, no third-party relay — just our WSS, which rides the hub's Cloudflare tunnel.
//
// Protocol (JSON per frame):
//   agent -> hub: {type:'hello', agentId, version, roles}   (on connect)
//                 {type:'reply', id, ok, output?, error?}    (answering a cmd)
//                 {type:'heartbeat'}                          (keepalive)
//   hub  -> agent: {type:'cmd', id, cmd:'deploy'|'exec'|'ping', ...args}

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
    return m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string' ? m : null;
  } catch {
    return null;
  }
}

interface Entry { socket: AgentSocket; info: AgentInfo; }
interface Pending { resolve: (r: AgentReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; }

export class AgentGateway {
  private byId = new Map<string, Entry>();
  private idOf = new Map<AgentSocket, string>();
  private pending = new Map<string, Pending>();

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
    switch (m.type) {
      case 'hello': {
        const id = String(m.agentId ?? '').trim();
        if (!id) return;
        const prev = this.byId.get(id);
        if (prev && prev.socket !== socket) { try { prev.socket.close(); } catch { /* gone */ } this.idOf.delete(prev.socket); }
        const info: AgentInfo = {
          id,
          version: m.version != null ? String(m.version) : null,
          roles: Array.isArray(m.roles) ? m.roles.map(String) : [],
          connectedAt: new Date().toISOString(),
        };
        this.byId.set(id, { socket, info });
        this.idOf.set(socket, id);
        break;
      }
      case 'reply': {
        const p = this.pending.get(String(m.id ?? ''));
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(String(m.id));
        p.resolve({ ok: !!m.ok, output: m.output != null ? String(m.output) : undefined, error: m.error != null ? String(m.error) : undefined });
        break;
      }
      // heartbeat: presence only for now (the socket staying open is the signal).
    }
  }

  onClose(socket: AgentSocket): void {
    const id = this.idOf.get(socket);
    this.idOf.delete(socket);
    if (id && this.byId.get(id)?.socket === socket) this.byId.delete(id);
  }

  // Send a command to an agent and resolve with its reply (or reject on timeout / not connected).
  send(agentId: string, cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<AgentReply> {
    const entry = this.byId.get(agentId);
    if (!entry) return Promise.reject(new Error(`agent not connected: ${agentId}`));
    const id = randomUUID();
    return new Promise<AgentReply>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('agent command timed out')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        entry.socket.send(JSON.stringify({ type: 'cmd', id, ...cmd }));
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
