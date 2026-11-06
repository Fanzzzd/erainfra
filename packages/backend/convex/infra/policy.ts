// Pure rules for the infrastructure-management state that moved out of the Hub (ADR 0016).
// Free of Convex bindings so the rules can be unit tested directly, like apiTokenPolicy.ts.

/**
 * One identity system for both surfaces. A caller is one of three principals:
 *
 * - a **user**, signed in through Convex Auth, holding one permission role;
 * - an **API token** from the dashboard (`apiTokens`), holding one scope;
 * - a **Node**, presenting its own enrollment credential (`nodeCredentials`).
 *
 * The Hub kept a second user table, its own sessions and `plt_` tokens. Those map onto the
 * first two kinds; the third replaces the shared `operator` token every Node used to hold.
 */
export const PERMISSION_ROLES = ["owner", "admin", "operator", "viewer"] as const;
export type PermissionRole = (typeof PERMISSION_ROLES)[number];

/**
 * The Hub's permissions (apps/hub/src/rbac.ts), in EraInfra words. The Hub's `agent.run`, the
 * right to run an allowlisted host operation on a Node, is `node.run` here. `node.admin` is new:
 * enrolling a Node, revoking its credentials, resetting its endpoint and setting its placement
 * roles. The Hub had no such right because every Node joined with the shared operator token.
 */
export const PERMISSIONS = [
  "app.read",
  "app.deploy",
  "node.run",
  "node.admin",
  "audit.read",
  "account.admin",
  "chat.read",
  "chat.write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: readonly Permission[] = ["app.read", "audit.read"];

/** The Hub's role table, unchanged apart from the `node.run` rename. */
const ROLE_PERMISSIONS: Record<PermissionRole, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: [
    ...READ_ONLY,
    "app.deploy",
    "node.run",
    "node.admin",
    "account.admin",
    "chat.read",
    "chat.write",
  ],
  operator: [...READ_ONLY, "app.deploy"],
  viewer: READ_ONLY,
};

/**
 * What an API token's scope grants on the infrastructure surface. A token never administers
 * accounts: no HTTP route mints a token or a user (apiTokens.ts), so a leaked token cannot outlive
 * its own revocation. Transcripts stay with humans for the same reason the Hub kept them from
 * operator tokens.
 *
 * An admin token administers Nodes (`node.admin`), because the operator API is how Nodes are
 * enrolled from a terminal. A Node credential is not an API token and is refused on /api/v1, so a
 * leaked admin token still cannot mint its own replacement. It reaches nothing the token could not
 * already reach: `app.deploy` runs any image on any Node.
 */
const SCOPE_PERMISSIONS: Record<"read" | "admin" | "metrics", readonly Permission[]> = {
  read: READ_ONLY,
  admin: [...READ_ONLY, "app.deploy", "node.run", "node.admin"],
  metrics: [],
};

export type Principal =
  | { kind: "user"; userId: string; role: PermissionRole }
  | { kind: "token"; tokenId: string; scope: "read" | "admin" | "metrics" }
  // A Node holds no permission from the table. It may only act on itself and read what a deploy
  // addressed to it needs, which the functions serving it check against `nodeId` directly.
  | { kind: "node"; nodeId: string };

export function can(principal: Principal, permission: Permission) {
  switch (principal.kind) {
    case "user":
      return ROLE_PERMISSIONS[principal.role].includes(permission);
    case "token":
      return SCOPE_PERMISSIONS[principal.scope].includes(permission);
    case "node":
      return false;
  }
}

/**
 * Accounts created before roles existed have no `role` field. Every one of them could do
 * everything in the dashboard, so reading the absence as `owner` keeps them working unchanged.
 */
export function effectiveRole(role: PermissionRole | undefined): PermissionRole {
  return role ?? "owner";
}

const RANK: Record<PermissionRole, number> = { viewer: 0, operator: 1, admin: 2, owner: 3 };

/** Nobody grants or takes away a role above their own; only an owner hands out `owner`. */
export function mayAssignRole(actor: PermissionRole, from: PermissionRole, to: PermissionRole) {
  return RANK[actor] >= RANK[from] && RANK[actor] >= RANK[to];
}

/**
 * The Hub stored a list of roles per user, though its UI only ever assigned one. The highest one
 * is what the list granted.
 */
export function roleFromHubRoles(roles: readonly string[]): PermissionRole {
  let best: PermissionRole = "viewer";
  for (const role of roles) {
    if ((PERMISSION_ROLES as readonly string[]).includes(role)) {
      const candidate = role as PermissionRole;
      if (RANK[candidate] > RANK[best]) best = candidate;
    }
  }
  return best;
}

/** Whether the existing CI dashboard functions, written for full-trust accounts, admit a role. */
export function isDashboardAdmin(role: PermissionRole) {
  return RANK[role] >= RANK.admin;
}

// ---------------------------------------------------------------------------
// Ports

/**
 * The host-port range the Hub allocates from (apps/hub/src/runtime/ports.ts). Unchanged, so a
 * port an App already bakes into its containers' environment stays valid after the import.
 */
export const PORT_RANGE_START = 62000;
export const PORT_RANGE_END = 63999;

/**
 * The lowest free port, given the ports already used on a Node in ascending order. Null when the
 * range is full.
 */
export function firstFreePort(usedAscending: Iterable<number>) {
  let candidate = PORT_RANGE_START;
  for (const port of usedAscending) {
    if (port < candidate) continue;
    if (port > candidate) break;
    candidate += 1;
  }
  return candidate <= PORT_RANGE_END ? candidate : null;
}

/** Port keys are `<app>/<purpose>`; releasing an App frees every key under its prefix. */
export function appOfPortKey(key: string) {
  const slash = key.indexOf("/");
  return slash > 0 ? key.slice(0, slash) : undefined;
}

// ---------------------------------------------------------------------------
// Git bindings, deployments

/** The Hub's cap on push-to-deploy bindings. */
export const MAX_GIT_BINDINGS = 200;

/** GitHub repository names are case-insensitive; branch names are not. */
export function repoKey(repo: string) {
  return repo.trim().toLowerCase();
}

/** Deployment records kept, newest first, as on the Hub. */
export const DEPLOYMENTS_KEPT = 1000;

export const DEPLOY_STAGES = [
  "queued",
  "reading-spec",
  "planning",
  "building",
  "deploying",
  "linking",
  "done",
  "failed",
] as const;
export type DeployStage = (typeof DEPLOY_STAGES)[number];

export function isTerminalStage(stage: DeployStage) {
  return stage === "done" || stage === "failed";
}

// ---------------------------------------------------------------------------
// Per-App operation leases (the ADR 0014 pattern, applied to an App instead of a Profile)

/** Long enough to cover one pipeline step; the holder renews between steps. */
export const APP_LEASE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Node liveness, from the heartbeats a connect-convex Infra Agent sends

/**
 * The longest a healthy Node goes between heartbeats. The Infra Agent heartbeats on a poll at
 * least 15 seconds after the last one, and an idle poll waits up to 30 seconds plus 20% jitter, so
 * about 36 seconds; the rest is network latency.
 */
export const HEARTBEAT_INTERVAL_BOUND_MS = 40_000;

/**
 * How many heartbeats in a row a Node must miss before Convex treats it as gone. One late or lost
 * heartbeat, or one dropped connection, is never enough: the Hub failed a Node over 20 seconds
 * after one WebSocket closed, which moved Apps off a Node that was still serving them.
 */
export const MISSED_HEARTBEATS = 3;

/** The silence that marks a Node as gone: MISSED_HEARTBEATS whole intervals. */
export const NODE_SILENCE_MS = HEARTBEAT_INTERVAL_BOUND_MS * MISSED_HEARTBEATS;

/**
 * After a check first finds a Node silent past NODE_SILENCE_MS, a later check must still find it
 * silent at least this long afterwards before failover runs. The Hub's 20-second grace, kept as a
 * second, independent observation of the same outage.
 */
export const FAILOVER_GRACE_MS = 20_000;

/** Whether a Node has heartbeated recently enough to be given work. */
export function isNodeLive(lastSeenAt: number | undefined, now: number) {
  return lastSeenAt !== undefined && now - lastSeenAt <= NODE_SILENCE_MS;
}

/** Whether a Node that has heartbeated before has now been silent for the whole window. */
export function isNodeSilent(lastSeenAt: number | undefined, now: number) {
  return lastSeenAt !== undefined && now - lastSeenAt > NODE_SILENCE_MS;
}

export type LeaseRow = {
  holder?: string;
  epoch: number;
  expiresAt: number;
};

export type LeaseDecision =
  | { grant: true; epoch: number; renewed: boolean }
  | { grant: false; heldBy: string; expiresAt: number };

/**
 * Whether `holder` may take the lease. A live lease belongs to its holder; anyone may take a free
 * or expired one, and every change of holder raises the epoch, so a write fenced on the old epoch
 * is refused even if its author has not yet noticed that it lost the lease.
 */
export function decideLease(row: LeaseRow | null, holder: string, now: number): LeaseDecision {
  if (row === null) return { grant: true, epoch: 1, renewed: false };
  const live = row.holder !== undefined && row.expiresAt > now;
  if (live && row.holder === holder) return { grant: true, epoch: row.epoch, renewed: true };
  if (live) return { grant: false, heldBy: row.holder!, expiresAt: row.expiresAt };
  return { grant: true, epoch: row.epoch + 1, renewed: false };
}

/** Whether a write fenced on `epoch` may proceed against the lease as it stands. */
export function leaseAdmits(row: LeaseRow | null, epoch: number, now: number) {
  return row !== null && row.holder !== undefined && row.epoch === epoch && row.expiresAt > now;
}

// ---------------------------------------------------------------------------
// Nodes

/**
 * A Node's enrollment credential. Distinct from an API token's `erainfra_` prefix so neither can
 * be presented where the other is expected, and recognisable to secret scanners.
 */
export const NODE_CREDENTIAL_PREFIX = "erainfra_node_";
const NODE_CREDENTIAL_PATTERN = /^erainfra_node_[0-9a-f]{64}$/;

export function newNodeCredential() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${NODE_CREDENTIAL_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function isWellFormedNodeCredential(token: string) {
  return NODE_CREDENTIAL_PATTERN.test(token);
}

/**
 * An iroh EndpointId: a 32-byte ed25519 public key. iroh renders it as 64 lowercase hex
 * characters; older releases used 52 z-base-32 characters, which is accepted too so the format
 * phase 1 settles on needs no schema change.
 */
const ENDPOINT_ID_PATTERN = /^(?:[0-9a-f]{64}|[ybndrfg8ejkmcpqxot1uwisza345h769]{52})$/;

export function isEndpointId(value: string) {
  return ENDPOINT_ID_PATTERN.test(value);
}

/** Node names are the Hub's agent ids; App names are its container names. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/i;

export function isValidName(name: string) {
  return NAME_PATTERN.test(name);
}

/** A valid environment variable name, as the Hub's secret store requires. */
export function isValidSecretName(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}
