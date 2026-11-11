// The Cloudflare platform host (ADR 0019): one Durable Object holds the whole control plane, and
// a Worker in front sends every request to it. The backend's entry file calls
// `createControlPlane({ modules, schema, auth })` and exports what it returns.
//
// Routes the object answers itself:
//   POST /api/query | /api/mutation | /api/action   Convex's HTTP function API
//   POST /api/storage/upload?token=...              an upload URL from generateUploadUrl
//   GET  /api/storage/<id>                          a stored file (getUrl)
//   GET  /api/<client version>/sync                 Convex's WebSocket sync protocol
// Everything else goes to the backend's http.ts router.

import { convexToJson, jsonToConvex, type JSONValue } from "convex/values";

import {
  FunctionError,
  NO_ROUTE,
  Runtime,
  type FileStore,
  type Kind,
  type Modules,
} from "../runtime/runtime.ts";
import type { Sql, SqlValue } from "../store/sql.ts";
import { schemaInfo } from "../store/store.ts";
import { SyncServer } from "../sync/session.ts";
import { JwtVerifier, type AuthProvider } from "./jwt.ts";

// The few Workers types the host needs, so the package does not depend on workers-types.
type SqlCursor = Iterable<Record<string, SqlValue>>;
export interface DurableObjectState {
  storage: {
    sql: { exec(query: string, ...bindings: SqlValue[]): SqlCursor };
    transactionSync<T>(fn: () => T): T;
    setAlarm(at: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface R2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
}
export interface R2Bucket {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}
// Workers' server-side WebSocket: accept() it, then listen for messages.
interface ServerWebSocket {
  accept(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", fn: (e: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close" | "error", fn: () => void): void;
}
declare const WebSocketPair: { new (): { 0: ServerWebSocket; 1: ServerWebSocket } };

// Convex's status for a function that threw; ConvexHttpClient reads the error body only for it.
const UDF_FAILED = 560;

const SYNC_PATH = /^\/api\/[^/]+\/sync$/;
const PING_MS = 20_000;

interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}

export type ControlPlaneEnv = {
  CONTROL_PLANE: DurableObjectNamespace;
  FILES?: R2Bucket;
  /** The deployment's public URL; also the JWT issuer (auth.config.ts reads CONVEX_SITE_URL). */
  CONVEX_SITE_URL?: string;
  JWKS?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
};

export type ControlPlaneOptions = {
  modules: Modules;
  schema: unknown;
  /** The backend's auth.config.ts default export. */
  auth?: { providers: AuthProvider[] };
};

class R2Files implements FileStore {
  constructor(private readonly bucket: R2Bucket) {}
  async put(key: string, bytes: Uint8Array, contentType: string | undefined) {
    await this.bucket.put(key, bytes, { httpMetadata: contentType ? { contentType } : {} });
  }
  async get(key: string) {
    const object = await this.bucket.get(key);
    if (!object) return null;
    return {
      bytes: new Uint8Array(await object.arrayBuffer()),
      contentType: object.httpMetadata?.contentType,
    };
  }
  async delete(key: string) {
    await this.bucket.delete(key);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const FUNCTION_ROUTES: Record<string, Kind> = {
  "/api/query": "query",
  "/api/mutation": "mutation",
  "/api/action": "action",
};

export function createControlPlane(options: ControlPlaneOptions) {
  class ControlPlane {
    private readonly runtime: Runtime;
    private readonly verifier: JwtVerifier | null;
    private readonly sync: SyncServer;
    private pinger: ReturnType<typeof setInterval> | null = null;

    constructor(state: DurableObjectState, env: ControlPlaneEnv) {
      const storage = state.storage;
      const sql: Sql = {
        exec: (query, ...bindings) => storage.sql.exec(query, ...bindings),
        transactionSync: (fn) => storage.transactionSync(fn),
      };
      this.runtime = new Runtime({
        modules: options.modules,
        schema: schemaInfo(options.schema as never),
        sql,
        files: env.FILES ? new R2Files(env.FILES) : undefined,
        siteUrl: env.CONVEX_SITE_URL,
        staticCatchAll: true,
        setAlarm: (at) => {
          void (at === null ? storage.deleteAlarm() : storage.setAlarm(at));
        },
      });
      this.verifier =
        env.JWKS && options.auth ? new JwtVerifier(env.JWKS, options.auth.providers) : null;
      const verifier = this.verifier;
      this.sync = new SyncServer(this.runtime, verifier ? (token) => verifier.verify(token) : null);
      // A fresh object has no alarm yet; crons and anything scheduled before a restart need one.
      this.runtime.start();
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (SYNC_PATH.test(url.pathname) && request.headers.get("Upgrade") === "websocket") {
        return this.acceptSync();
      }
      const kind = FUNCTION_ROUTES[url.pathname];
      if (kind && request.method === "POST") return this.callFunction(kind, request);
      if (url.pathname === "/api/storage/upload" && request.method === "POST") {
        const token = url.searchParams.get("token") ?? "";
        const bytes = new Uint8Array(await request.arrayBuffer());
        const id = await this.runtime.upload(
          token,
          bytes,
          request.headers.get("Content-Type") ?? undefined,
        );
        return id
          ? json({ storageId: id })
          : json({ error: "upload URL is invalid or expired" }, 403);
      }
      if (url.pathname.startsWith("/api/storage/") && request.method === "GET") {
        return this.serveFile(url.pathname.slice("/api/storage/".length));
      }
      return this.runtime.http(request);
    }

    async alarm(): Promise<void> {
      await this.runtime.runDue();
    }

    // Convex's HTTP API: { path, args, format: "json" } in; { status, value | errorMessage } out.
    private async callFunction(kind: Kind, request: Request): Promise<Response> {
      let identity;
      try {
        const header = request.headers.get("Authorization");
        identity = await (this.verifier?.verify(header?.replace(/^Bearer /, "") ?? null) ?? null);
      } catch (err) {
        return json({ status: "error", errorMessage: (err as Error).message }, 401);
      }
      const body = (await request.json()) as { path: string; args?: JSONValue };
      // The documented API sends `args` as an object; ConvexHttpClient sends a one-element array.
      const args = Array.isArray(body.args) ? (body.args[0] ?? {}) : (body.args ?? {});
      try {
        const value = await this.runtime.run(body.path, jsonToConvex(args), {
          identity,
          expect: kind,
          publicOnly: true,
        });
        return json({ status: "success", value: convexToJson(value), logLines: [] });
      } catch (err) {
        const e =
          err instanceof FunctionError ? err : new FunctionError((err as Error).message, undefined);
        return json(
          {
            status: "error",
            errorMessage: e.message,
            ...(e.data === undefined ? {} : { errorData: convexToJson(e.data) }),
            logLines: [],
          },
          UDF_FAILED,
        );
      }
    }

    // The object keeps open sockets in memory, so it stays resident while clients are connected.
    // Hibernation would need the subscriptions in SQLite (ADR 0019); the control plane has a few
    // dozen clients, which fit in the Paid plan's included duration.
    private acceptSync(): Response {
      const pair = new WebSocketPair();
      const socket = pair[1];
      socket.accept();
      const session = this.sync.connect(socket);
      socket.addEventListener("message", (e) => {
        void session.receive(
          typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data),
        );
      });
      // Convex clients reconnect after 60 s without a message from the server. The timer runs only
      // while a client is connected, so an idle object can still be evicted.
      this.pinger ??= setInterval(() => this.sync.ping(), PING_MS);
      const closed = () => {
        session.close();
        if (this.sync.size === 0 && this.pinger) {
          clearInterval(this.pinger);
          this.pinger = null;
        }
      };
      socket.addEventListener("close", closed);
      socket.addEventListener("error", closed);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }

    private async serveFile(id: string): Promise<Response> {
      const file = await this.runtime.readFile(id);
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(file.bytes.slice().buffer, {
        headers: file.contentType ? { "Content-Type": file.contentType } : {},
      });
    }
  }

  // The Worker. A GET for a file (a path whose last segment has a dot) tries the dashboard's
  // static assets first. Everything else goes to the one object; a GET no HTTP route matches
  // falls back to the assets, whose SPA handling serves index.html for dashboard routes.
  const worker = {
    async fetch(request: Request, env: ControlPlaneEnv): Promise<Response> {
      const url = new URL(request.url);
      const isGet = request.method === "GET" || request.method === "HEAD";
      const lastSegment = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      const looksLikeFile = lastSegment.includes(".") && !url.pathname.startsWith("/.well-known/");
      if (env.ASSETS && isGet && looksLikeFile) {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status !== 404) return asset;
      }
      const stub = env.CONTROL_PLANE.get(env.CONTROL_PLANE.idFromName("control-plane"));
      const response = await stub.fetch(request);
      if (env.ASSETS && isGet && response.headers.get(NO_ROUTE)) return env.ASSETS.fetch(request);
      return response;
    },
  };

  return { ControlPlane, worker };
}
