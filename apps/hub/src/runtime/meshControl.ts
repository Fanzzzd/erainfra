import type { AgentCommand, AgentGateway } from "./agents.ts";
import type { MeshLink } from "./links.ts";

export const MESH_CAPABILITY = "erainfra-mesh/v1";
export type MeshPeer = { id: string; relay_urls: string[]; direct_addrs: string[] };
export type MeshExposure = { name: string; target: string; allowed_peers: string[] };
export type MeshConsumer = { name: string; peer: string; service: string; listen: string };
export type MeshDesired = {
  v: 1;
  fleet: MeshPeer[];
  relays: { relays: string[]; auth_token?: string; n0_fallback: boolean };
  exposures: MeshExposure[];
  links: MeshConsumer[];
};
type Gateway = Pick<AgentGateway, "list" | "send">;
type MeshStatus = {
  endpoint_id: string;
  addr: MeshPeer;
  exposures?: Array<{ name: string; allowed_peers?: string[] | null }>;
  links?: Array<{ name: string; peer?: string; bound?: string }>;
};

// Which transport carries a link. "mesh" is erainfra-mesh with per-consumer grants;
// "legacy-dumbpipe" is the unauthenticated ticket transport kept for the expand release, for a
// link with an end that has no sidecar. Once a link is recorded as "mesh" it never goes back.
export type LinkTransport = "mesh" | "legacy-dumbpipe";
export interface TransportStore {
  get(name: string): LinkTransport | undefined;
  set(name: string, transport: LinkTransport): void;
  delete(name: string): void;
  names(): string[];
}
export type MeshOptions = {
  transports: TransportStore;
  relays?: MeshDesired["relays"];
  // ERAINFRA_MESH_REQUIRE: refuse legacy links outright. Default false in the expand release.
  require?: boolean;
};
export type LinkOutcome = { transport: LinkTransport | "none"; ok: boolean; error?: string };
export type MeshReport = { links: Map<string, LinkOutcome>; errors: string[] };
export const LEGACY_WARNING =
  "unauthenticated: anyone holding this link's dumbpipe ticket can reach the service";

function status(output: string | undefined): MeshStatus {
  let s: MeshStatus;
  try {
    s = JSON.parse(output ?? "");
  } catch {
    throw new Error("invalid secure mesh status");
  }
  if (
    !s ||
    !/^[a-f0-9]{64}$/.test(s.endpoint_id) ||
    s.addr?.id !== s.endpoint_id ||
    !Array.isArray(s.addr.relay_urls) ||
    !Array.isArray(s.addr.direct_addrs) ||
    !s.addr.relay_urls.every((v) => typeof v === "string") ||
    !s.addr.direct_addrs.every((v) => typeof v === "string")
  ) {
    throw new Error("invalid secure mesh endpoint address");
  }
  return s;
}
export function meshSupport(gw: Gateway, id: string): string | null {
  const info = gw.list().find((n) => n.id === id);
  if (!info) return `node offline: ${id}`;
  return info.capabilities?.includes(MESH_CAPABILITY)
    ? null
    : `secure mesh unsupported on ${id}: install the verified erainfra-mesh sidecar (/install --role node --mesh)`;
}

// Pure adapter: fleet membership is not a service grant. Only declared consumer links populate
// allowed_peers. Several consumers of the same provider service share one exposure and grant set.
export function meshDesired(
  node: string,
  links: readonly MeshLink[],
  endpoints: ReadonlyMap<string, MeshPeer>,
  relays: MeshDesired["relays"] = { relays: [], n0_fallback: false },
): MeshDesired {
  const exposures = new Map<string, MeshExposure>();
  const consumers = new Map<string, MeshConsumer>();
  for (const link of links) {
    const provider = endpoints.get(link.provider);
    const consumer = endpoints.get(link.consumer);
    if (!provider || !consumer) continue; // An unsupported/disconnected Node is never granted access.
    if (link.provider === node) {
      const target = `127.0.0.1:${link.providerPort}`;
      const e = exposures.get(link.name) ?? { name: link.name, target, allowed_peers: [] };
      if (e.target !== target) throw new Error(`conflicting mesh exposure target: ${link.name}`);
      if (!e.allowed_peers.includes(consumer.id)) e.allowed_peers.push(consumer.id);
      exposures.set(link.name, e);
    }
    if (link.consumer === node) {
      // Existing bridge-bound links are an explicit compatibility choice so containers retain
      // host.docker.internal access. This is not the sidecar API's default (127.0.0.1).
      const l = {
        name: link.name,
        peer: provider.id,
        service: link.name,
        listen: `0.0.0.0:${link.localPort}`,
      };
      const old = consumers.get(link.name);
      if (old && JSON.stringify(old) !== JSON.stringify(l))
        throw new Error(`conflicting mesh consumer link: ${link.name}`);
      consumers.set(link.name, l);
    }
  }
  for (const e of exposures.values()) e.allowed_peers = e.allowed_peers.toSorted();
  return {
    v: 1,
    fleet: [...endpoints.values()],
    relays,
    exposures: [...exposures.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
    links: [...consumers.values()].toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

async function sendMesh(gw: Gateway, id: string, cmd: AgentCommand, timeoutMs: number) {
  try {
    const r = await gw.send(id, cmd, timeoutMs);
    return r.ok ? { output: r.output } : { error: r.error ?? "request refused" };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

// dumbpipe prints a ready-to-run `dumbpipe connect-tcp <ticket>` line; the agent returns it as the
// share's output. Same rule as parseTicket in the agent.
function ticketOf(output: string | undefined): string | undefined {
  const t = (output ?? "").trim();
  const m = /connect(?:-tcp)?\s+([a-z2-7]{48,})/i.exec(t) ?? /\b([a-z2-7]{64,})\b/i.exec(t);
  return m?.[1] ?? (t || undefined);
}

// Legacy links this Hub process has brought up, per gateway, so a healer pass does not restart a
// working dumbpipe pair every minute. Forgotten when either end reconnects: an agent restart loses
// its dumbpipe processes.
const legacyUp = new WeakMap<object, Map<string, MeshLink>>();
function legacyOf(gw: Gateway): Map<string, MeshLink> {
  let m = legacyUp.get(gw);
  if (!m) legacyUp.set(gw, (m = new Map()));
  return m;
}
export function forgetLegacyLinks(gw: Gateway, agentId: string): void {
  const up = legacyOf(gw);
  for (const [name, l] of up) if (l.provider === agentId || l.consumer === agentId) up.delete(name);
}
const lastOutcomes = new WeakMap<object, Map<string, LinkOutcome>>();

async function dropLegacy(gw: Gateway, l: MeshLink, ends: Array<"provider" | "consumer">) {
  for (const end of ends) await sendMesh(gw, l[end], { cmd: "meshDrop", name: l.name }, 30_000);
}

async function establishLegacy(gw: Gateway, l: MeshLink): Promise<string | undefined> {
  const share = await sendMesh(
    gw,
    l.provider,
    { cmd: "meshShare", name: l.name, port: l.providerPort },
    60_000,
  );
  const ticket = share.error === undefined ? ticketOf(share.output) : undefined;
  if (!ticket) return `provider share failed: ${share.error ?? "no ticket returned"}`;
  // The ticket is a capability to reach the service: kept Hub-internal, never logged or returned.
  const conn = await sendMesh(
    gw,
    l.consumer,
    { cmd: "meshConnect", name: l.name, ticket, port: l.localPort },
    60_000,
  );
  return conn.error === undefined ? undefined : `consumer connect failed: ${conn.error}`;
}

// A mesh link is up when the provider grants exactly this consumer and the consumer's listener is
// bound, both as reported by the sidecars after the second stage.
function meshLinkVerified(
  l: MeshLink,
  endpoints: ReadonlyMap<string, MeshPeer>,
  after: ReadonlyMap<string, MeshStatus>,
): boolean {
  const consumerId = endpoints.get(l.consumer)?.id;
  const exposure = after.get(l.provider)?.exposures?.find((e) => e.name === l.name);
  const link = after.get(l.consumer)?.links?.find((x) => x.name === l.name);
  return (
    consumerId !== undefined &&
    !!exposure?.allowed_peers?.includes(consumerId) &&
    link?.peer === endpoints.get(l.provider)?.id &&
    !!link?.bound
  );
}

// One pass over every link. Per link, the transport is chosen once and never mixed:
//   - recorded "mesh", or both ends advertise erainfra-mesh/v1: the mesh, with grants;
//   - otherwise, an end has no sidecar: legacy dumbpipe, unless ERAINFRA_MESH_REQUIRE refuses it.
// A link moving from dumbpipe to the mesh is migrated inside the pass: grants first, then the
// consumer's dumbpipe listener is dropped to free its port, then the mesh listener opens, and only
// after both sidecars confirm it is the provider's dumbpipe share dropped and the link recorded as
// "mesh". A recorded mesh link whose end stops answering reports degraded; it never falls back.
//
// A Node that fails is reported and skipped, never allowed to stop the pass: the pass also carries
// revocations, and one unreachable Node must not keep a revoked grant alive on every other provider.
async function reconcileOnce(
  gw: Gateway,
  links: readonly MeshLink[],
  opts: MeshOptions,
): Promise<MeshReport> {
  const { transports, relays } = opts;
  const connected = new Set(gw.list().map((n) => n.id));
  const capable = new Set(
    gw
      .list()
      .filter((n) => n.capabilities?.includes(MESH_CAPABILITY))
      .map((n) => n.id),
  );
  const endpoints = new Map<string, MeshPeer>();
  const errors: string[] = [];
  const outcomes = new Map<string, LinkOutcome>();
  const nodeErrors = new Map<string, string>();
  for (const id of capable) {
    const r = await sendMesh(gw, id, { cmd: "meshStatus", meshVersion: 1 }, 15_000);
    if (r.error !== undefined) {
      // Left out of `endpoints`, so every provider drops its grants this pass: fail closed.
      errors.push(`mesh status unavailable on ${id}: ${r.error}`);
      nodeErrors.set(id, `mesh status unavailable on ${id}: ${r.error}`);
      continue;
    }
    const addr = status(r.output).addr;
    if ([...endpoints.values()].some((other) => other.id === addr.id))
      throw new Error("two Nodes report the same mesh identity");
    endpoints.set(id, addr);
  }

  const onMesh: MeshLink[] = [];
  const onLegacy: MeshLink[] = [];
  for (const l of links) {
    const bothCapable = capable.has(l.provider) && capable.has(l.consumer);
    (transports.get(l.name) === "mesh" || bothCapable ? onMesh : onLegacy).push(l);
  }

  // Compute every Node's view before changing any, so a conflicting link name fails the pass
  // before a single grant moves. Links whose other end is not answering get no grant.
  const desired = new Map(
    [...endpoints.keys()].map((id) => [id, meshDesired(id, onMesh, endpoints, relays)]),
  );
  const authorized = new Set<string>();
  for (const [id, d] of desired) {
    const r = await sendMesh(
      gw,
      id,
      { cmd: "meshApply", meshVersion: 1, stage: "authorize", desired: d },
      120_000,
    );
    if (r.error !== undefined) {
      errors.push(`mesh authorization failed on ${id}: ${r.error}`);
      nodeErrors.set(id, `mesh authorization failed on ${id}: ${r.error}`);
      continue;
    }
    endpoints.set(id, status(r.output).addr);
    authorized.add(id);
  }
  // Free the consumer port of every link moving onto the mesh. Harmless for a link that never ran
  // on dumbpipe: the agent answers "no such link".
  // A link whose ends were not both authorized stays off the second stage this pass, so its
  // consumer keeps any dumbpipe listener rather than having the mesh listener collide with it.
  const held = new Set(
    onMesh
      .filter((l) => transports.get(l.name) !== "mesh")
      .filter((l) => !(authorized.has(l.provider) && authorized.has(l.consumer)))
      .map((l) => l.name),
  );
  const listening = onMesh.filter((l) => !held.has(l.name));
  for (const l of listening)
    if (transports.get(l.name) !== "mesh") await dropLegacy(gw, l, ["consumer"]);
  // Relay changes can rebind endpoints, so the second stage carries the addresses each Node
  // reported after the first. Every provider's grants are in place before any consumer listens.
  const after = new Map<string, MeshStatus>();
  for (const id of authorized) {
    const d = meshDesired(id, listening, endpoints, relays);
    const r = await sendMesh(
      gw,
      id,
      { cmd: "meshApply", meshVersion: 1, stage: "links", desired: d },
      120_000,
    );
    if (r.error !== undefined) {
      errors.push(`mesh link failed on ${id}: ${r.error}`);
      nodeErrors.set(id, `mesh link failed on ${id}: ${r.error}`);
    } else after.set(id, status(r.output));
  }
  const up = legacyOf(gw);
  for (const l of onMesh) {
    if (meshLinkVerified(l, endpoints, after)) {
      if (transports.get(l.name) !== "mesh") {
        await dropLegacy(gw, l, ["provider"]);
        up.delete(l.name);
        transports.set(l.name, "mesh");
      }
      outcomes.set(l.name, { transport: "mesh", ok: true });
    } else {
      const reasons = [l.provider, l.consumer]
        .map((n) =>
          !connected.has(n)
            ? `node offline: ${n}`
            : !capable.has(n)
              ? meshSupport(gw, n)
              : (nodeErrors.get(n) ?? (after.has(n) ? undefined : `no mesh answer from ${n}`)),
        )
        .filter(Boolean);
      const why = reasons.join("; ") || "the sidecars did not confirm the grant and listener";
      const recorded = transports.get(l.name);
      const error =
        recorded === "mesh"
          ? `degraded: ${why}; it stays on the mesh`
          : recorded === "legacy-dumbpipe"
            ? `migration to the mesh not confirmed: ${why}; retried next pass`
            : `mesh link not up: ${why}`;
      outcomes.set(l.name, { transport: "mesh", ok: false, error });
    }
  }

  for (const l of onLegacy) {
    const legacyEnd = [l.provider, l.consumer].find((n) => connected.has(n) && !capable.has(n));
    if (opts.require) {
      if (up.has(l.name)) {
        await dropLegacy(gw, up.get(l.name)!, ["consumer", "provider"]);
        up.delete(l.name);
      }
      outcomes.set(l.name, {
        transport: "none",
        ok: false,
        error: `legacy link refused (ERAINFRA_MESH_REQUIRE=true): ${meshSupport(gw, legacyEnd ?? (connected.has(l.provider) ? l.consumer : l.provider))}`,
      });
      continue;
    }
    const offline = [l.provider, l.consumer].filter((n) => !connected.has(n));
    if (offline.length) {
      outcomes.set(l.name, {
        transport: transports.get(l.name) ?? "none",
        ok: false,
        error: `node offline: ${offline.join(", ")}`,
      });
      continue;
    }
    const known = up.get(l.name);
    if (known && JSON.stringify(known) === JSON.stringify(l)) {
      outcomes.set(l.name, { transport: "legacy-dumbpipe", ok: true });
      continue;
    }
    const error = await establishLegacy(gw, l);
    if (error === undefined) {
      up.set(l.name, l);
      transports.set(l.name, "legacy-dumbpipe");
    }
    outcomes.set(l.name, { transport: "legacy-dumbpipe", ok: error === undefined, error });
  }

  // A link gone from the desired view: end any dumbpipe pair this Hub started for it (its mesh half
  // was revoked by omission above) and forget its transport.
  const wanted = new Set(links.map((l) => l.name));
  for (const [name, l] of up)
    if (!wanted.has(name)) {
      await dropLegacy(gw, l, ["consumer", "provider"]);
      up.delete(name);
    }
  for (const name of transports.names()) if (!wanted.has(name)) transports.delete(name);
  lastOutcomes.set(gw, outcomes);
  return { links: outcomes, errors };
}

// One serial queue per gateway: a reconnect sweep cannot race link creation or revocation. The
// link list is read when the pass starts, not when it was queued, so a queued sweep never
// re-applies a link deleted while it waited.
const queues = new WeakMap<object, Promise<unknown>>();
export function reconcileMesh(
  gw: Gateway,
  links: readonly MeshLink[] | (() => readonly MeshLink[]),
  opts: MeshOptions,
): Promise<MeshReport> {
  const previous = queues.get(gw) ?? Promise.resolve();
  const run = previous
    .catch(() => undefined)
    .then(() => reconcileOnce(gw, typeof links === "function" ? links() : links, opts));
  queues.set(
    gw,
    run.catch(() => undefined),
  );
  return run;
}

export type LinkState = {
  transport: LinkTransport | "none";
  authenticated: boolean;
  state: "secure" | "degraded" | "migrating" | "legacy" | "refused" | "offline";
  warning?: string;
  error?: string;
};

// What `mesh.list` and the CLI show for a link, without running a pass: the recorded transport,
// what the next pass will do, and the last pass's error.
export function describeLink(
  gw: Gateway,
  l: MeshLink,
  opts: Pick<MeshOptions, "transports" | "require">,
): LinkState {
  const nodes = new Map(gw.list().map((n) => [n.id, n]));
  const capable = (id: string) => !!nodes.get(id)?.capabilities?.includes(MESH_CAPABILITY);
  const last = lastOutcomes.get(gw)?.get(l.name);
  const recorded = opts.transports.get(l.name);
  const both = capable(l.provider) && capable(l.consumer);
  if (recorded === "mesh") {
    const ok = both && last?.ok !== false;
    return {
      transport: "mesh",
      authenticated: true,
      state: ok ? "secure" : "degraded",
      error: ok ? undefined : (last?.error ?? "an end is offline or has no erainfra-mesh"),
    };
  }
  if (both)
    return {
      transport: recorded ?? "none",
      authenticated: false,
      state: "migrating",
      error: last?.error,
    };
  const legacyEnd = [l.provider, l.consumer].find((n) => nodes.has(n) && !capable(n));
  const advice = legacyEnd
    ? `; install erainfra-mesh on ${legacyEnd} (/install --role node --mesh) to migrate it`
    : "";
  if (opts.require)
    return {
      transport: "none",
      authenticated: false,
      state: "refused",
      error: `legacy link refused (ERAINFRA_MESH_REQUIRE=true)${advice}`,
    };
  if (!nodes.has(l.provider) || !nodes.has(l.consumer))
    return {
      transport: recorded ?? "none",
      authenticated: false,
      state: "offline",
      error: last?.error,
    };
  return {
    transport: "legacy-dumbpipe",
    authenticated: false,
    state: "legacy",
    warning: LEGACY_WARNING + advice,
    error: last?.ok === false ? last.error : undefined,
  };
}
