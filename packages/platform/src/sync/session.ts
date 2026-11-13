// Convex's WebSocket sync protocol, served from the Cloudflare platform (ADR 0019). The dashboard's
// ConvexReactClient and the Action Runner Agent's ConvexClient connect here unmodified; only the
// deployment URL differs. The protocol is in convex/src/browser/sync/protocol.ts.
//
// Each connection is a SyncSession with three versions the client checks on every Transition: its
// query set, its identity, and a timestamp. A query re-runs when a commit writes a table it read.
// Convex tracks reads per index range; per table re-runs more often but returns the same values.

import { convexToJson, jsonToConvex, type JSONValue, type Value } from "convex/values";

import type { Identity, QueryOutcome, Runtime } from "../runtime/runtime.ts";

/** The part of a WebSocket a session uses. */
export interface SyncSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/** Turns a client's JWT into an identity. Throws for a token it rejects. */
export type VerifyToken = (token: string) => Promise<Identity>;

type Version = { querySet: number; ts: bigint; identity: number };

type ClientMessage =
  | { type: "Connect"; sessionId: string }
  | {
      type: "ModifyQuerySet";
      baseVersion: number;
      newVersion: number;
      modifications: (
        | { type: "Add"; queryId: number; udfPath: string; args: JSONValue[] }
        | { type: "Remove"; queryId: number }
      )[];
    }
  | {
      type: "Authenticate";
      tokenType: "User" | "Admin" | "None";
      value?: string;
      baseVersion: number;
    }
  | FunctionRequest
  | { type: "Event" };

type FunctionRequest = {
  type: "Mutation" | "Action";
  requestId: number;
  udfPath: string;
  args: JSONValue[];
};

type Modification =
  | { type: "QueryUpdated"; queryId: number; value: JSONValue; logLines: []; journal: null }
  | {
      type: "QueryFailed";
      queryId: number;
      errorMessage: string;
      errorData?: JSONValue;
      logLines: [];
      journal: null;
    }
  | { type: "QueryRemoved"; queryId: number };

type Subscription = {
  udfPath: string;
  args: Value;
  reads: ReadonlySet<string>;
  /** The last result sent, as JSON text, so an unchanged re-run sends nothing. */
  last: string | null;
};

/** Convex encodes a u64 as 8 little-endian bytes in base64. */
function encodeTs(ts: bigint): string {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, ts, true);
  return btoa(String.fromCharCode(...bytes));
}

const encodeVersion = (v: Version) => ({
  querySet: v.querySet,
  identity: v.identity,
  ts: encodeTs(v.ts),
});

function modificationFor(queryId: number, outcome: QueryOutcome): Modification {
  if (outcome.ok) {
    return {
      type: "QueryUpdated",
      queryId,
      value: convexToJson(outcome.value),
      logLines: [],
      journal: null,
    };
  }
  return {
    type: "QueryFailed",
    queryId,
    errorMessage: outcome.error.message,
    ...(outcome.error.data === undefined ? {} : { errorData: convexToJson(outcome.error.data) }),
    logLines: [],
    journal: null,
  };
}

function failureFields(err: unknown): { result: string; errorData?: JSONValue } {
  const e = err as Error & { data?: Value };
  return {
    result: e.message,
    ...(e.data === undefined ? {} : { errorData: convexToJson(e.data) }),
  };
}

export class SyncServer {
  private readonly sessions = new Set<SyncSession>();
  private ts: bigint;

  constructor(
    readonly runtime: Runtime,
    readonly verify: VerifyToken | null,
    private readonly now: () => number = Date.now,
  ) {
    // Nanoseconds since the epoch, as Convex's timestamps are. Starting from the clock keeps them
    // increasing across restarts of the object, so a reconnecting client never sees time go back.
    this.ts = BigInt(this.now()) * 1_000_000n;
    runtime.store.onCommit((tables) => {
      this.advance();
      for (const session of this.sessions) session.invalidate(tables);
    });
  }

  private advance(): void {
    const clock = BigInt(this.now()) * 1_000_000n;
    this.ts = clock > this.ts ? clock : this.ts + 1n;
  }

  currentTs(): bigint {
    return this.ts;
  }

  connect(socket: SyncSocket): SyncSession {
    const session = new SyncSession(this, socket, () => this.sessions.delete(session));
    this.sessions.add(session);
    return session;
  }

  /** Sends a protocol Ping to every client. Convex clients reconnect after 60 s of silence. */
  ping(): void {
    for (const session of this.sessions) session.send({ type: "Ping" });
  }

  get size(): number {
    return this.sessions.size;
  }
}

export class SyncSession {
  private version: Version = { querySet: 0, ts: 0n, identity: 0 };
  private identity: Identity = null;
  private readonly queries = new Map<number, Subscription>();
  private chain: Promise<void> = Promise.resolve();
  /** Tables written since the last refresh; null when no refresh is queued. */
  private stale: Set<string> | null = null;
  /**
   * Set after a mutation response. The client resolves a mutation only when a Transition arrives
   * after its response, so the next refresh sends one even if no query changed.
   */
  private owesTransition = false;
  private closed = false;

  constructor(
    private readonly server: SyncServer,
    private readonly socket: SyncSocket,
    private readonly onClose: () => void,
  ) {}

  send(message: unknown): void {
    if (!this.closed) this.socket.send(JSON.stringify(message));
  }

  /** Handles one client message. Messages are handled in order; actions run beside them. */
  receive(text: string): Promise<void> {
    return this.enqueue(() => this.handle(JSON.parse(text) as ClientMessage));
  }

  close(): void {
    this.closed = true;
    this.onClose();
  }

  /** Called after each commit with the tables it wrote. */
  invalidate(tables: ReadonlySet<string>): void {
    if (this.closed) return;
    if (this.stale) {
      for (const t of tables) this.stale.add(t);
      return;
    }
    this.stale = new Set(tables);
    void this.enqueue(() => this.refresh());
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    const next = this.chain.then(job).catch((err: unknown) => this.fatal((err as Error).message));
    this.chain = next;
    return next;
  }

  private fatal(error: string): void {
    this.send({ type: "FatalError", error });
    this.socket.close(1011, error.slice(0, 120));
    this.close();
  }

  private transition(modifications: Modification[], next: Partial<Version>): void {
    const end: Version = {
      ...this.version,
      ...next,
      ts: this.server.currentTs() > this.version.ts ? this.server.currentTs() : this.version.ts,
    };
    this.send({
      type: "Transition",
      startVersion: encodeVersion(this.version),
      endVersion: encodeVersion(end),
      modifications,
    });
    this.version = end;
  }

  // Runs the given subscriptions and returns a modification for each result that changed.
  private async rerun(ids: number[], always: boolean): Promise<Modification[]> {
    const subs = ids.map((id) => [id, this.queries.get(id) as Subscription] as const);
    const outcomes = await this.server.runtime.runQueries(
      subs.map(([, s]) => ({ udfPath: s.udfPath, args: s.args })),
      this.identity,
    );
    const mods: Modification[] = [];
    subs.forEach(([id, sub], i) => {
      const outcome = outcomes[i];
      const mod = modificationFor(id, outcome);
      const text = JSON.stringify(mod);
      sub.reads = outcome.reads;
      if (always || text !== sub.last) mods.push(mod);
      sub.last = text;
    });
    return mods;
  }

  private async refresh(): Promise<void> {
    const tables = this.stale ?? new Set<string>();
    this.stale = null;
    const ids = [...this.queries]
      .filter(([, s]) => [...s.reads].some((t) => tables.has(t)))
      .map(([id]) => id);
    const mods = ids.length ? await this.rerun(ids, false) : [];
    if (mods.length > 0 || this.owesTransition) this.transition(mods, {});
    this.owesTransition = false;
  }

  private async handle(msg: ClientMessage): Promise<void> {
    switch (msg.type) {
      case "Connect":
      case "Event":
        return;
      case "ModifyQuerySet":
        return this.modifyQuerySet(msg);
      case "Authenticate":
        return this.authenticate(msg);
      case "Mutation":
        return this.mutation(msg);
      case "Action":
        // An action can take seconds; query updates keep flowing while it runs.
        void this.action(msg);
        return;
    }
  }

  private async modifyQuerySet(msg: Extract<ClientMessage, { type: "ModifyQuerySet" }>) {
    if (msg.baseVersion !== this.version.querySet) {
      throw new Error(
        `ModifyQuerySet base version ${msg.baseVersion} does not match ${this.version.querySet}`,
      );
    }
    const added: number[] = [];
    const removed: Modification[] = [];
    for (const m of msg.modifications) {
      if (m.type === "Add") {
        this.queries.set(m.queryId, {
          udfPath: m.udfPath,
          args: jsonToConvex(m.args[0] ?? {}),
          reads: new Set(),
          last: null,
        });
        added.push(m.queryId);
      } else {
        this.queries.delete(m.queryId);
        removed.push({ type: "QueryRemoved", queryId: m.queryId });
      }
    }
    const mods = added.length ? await this.rerun(added, true) : [];
    this.transition([...removed, ...mods], { querySet: msg.newVersion });
  }

  private async authenticate(msg: Extract<ClientMessage, { type: "Authenticate" }>) {
    let identity: Identity = null;
    try {
      if (msg.tokenType === "Admin") throw new Error("Admin authentication is not supported");
      if (msg.tokenType === "User") {
        if (!this.server.verify) throw new Error("This deployment has no auth providers");
        identity = await this.server.verify(msg.value ?? "");
      }
    } catch (err) {
      this.send({
        type: "AuthError",
        error: (err as Error).message,
        baseVersion: msg.baseVersion,
        authUpdateAttempted: true,
      });
      return;
    }
    this.identity = identity;
    // Every query depends on who is asking, so all of them re-run. The Transition raises the
    // identity version, which is how the client learns its token was accepted.
    const mods = await this.rerun([...this.queries.keys()], false);
    this.transition(mods, { identity: msg.baseVersion + 1 });
  }

  private async mutation(msg: FunctionRequest) {
    try {
      const value = await this.server.runtime.run(msg.udfPath, jsonToConvex(msg.args[0] ?? {}), {
        identity: this.identity,
        expect: "mutation",
        publicOnly: true,
      });
      this.send({
        type: "MutationResponse",
        requestId: msg.requestId,
        success: true,
        result: convexToJson(value),
        ts: encodeTs(this.server.currentTs()),
        logLines: [],
      });
      this.owesTransition = true;
      this.invalidate(new Set());
    } catch (err) {
      this.send({
        type: "MutationResponse",
        requestId: msg.requestId,
        success: false,
        ...failureFields(err),
        logLines: [],
      });
    }
  }

  private async action(msg: FunctionRequest) {
    try {
      const value = await this.server.runtime.run(msg.udfPath, jsonToConvex(msg.args[0] ?? {}), {
        identity: this.identity,
        expect: "action",
        publicOnly: true,
      });
      this.send({
        type: "ActionResponse",
        requestId: msg.requestId,
        success: true,
        result: convexToJson(value),
        logLines: [],
      });
    } catch (err) {
      this.send({
        type: "ActionResponse",
        requestId: msg.requestId,
        success: false,
        ...failureFields(err),
        logLines: [],
      });
    }
  }
}
