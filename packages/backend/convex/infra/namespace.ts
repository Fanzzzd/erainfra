// One owner per name. A deploy derives runtime names for an App by joining the App's name with a
// service, volume or dependency name: container `<app>-<service>`, volume `<app>-<volume>`, network
// `<app>-net`, mesh link `linkName(app, need)` (plan.ts), and the `route: true` label
// `<app>-<service>` (spec.ts). App and service names may both contain `-`, so two Apps can derive
// the same name: App `shop` service `web-api` and App `shop-web` service `api` are both container
// `shop-web-api`, and App `shop` volume `db-data` and App `shop-db` volume `data` are both volume
// `shop-db-data`. The Infra Agent then replaces the other App's container, or mounts its data.
//
// Those names are already on deployed Nodes and cannot change (CONTEXT.md, rule 4). So instead of
// a new scheme, every name a plan derives is checked against the names every other App already
// holds, and a plan that derives one of them fails with an error naming both Apps.
//
// Why a check of exact names, not a rule on App names. Refusing an App whose name is a `-`-prefix
// of another's (`shop` and `shop-web`) closes the `-` joins, but it also refuses the common
// pairs that never collide (`shop` and `shop-staging`), would block every redeploy of such a pair
// copied from the Hub, and misses the two collisions that are not prefix joins: link names
// truncated to 30+30 characters, and a label a spec names explicitly (`route: shop`). The exact
// check covers all of them and refuses only a name that is actually taken.
//
// What another App holds is read from the rows that record it: each App row (its containers, its
// volumes from the Docker args, its links and routes, and its network), each route row (a
// single-container App the Hub deployed holds its label as both route and container), every run of
// another App that has planned but not yet committed (so two first deploys cannot both pass), and
// standalone mesh links. Docker names are per Node, but the check is fleet-wide: failover moves
// services between Nodes, and a name that is unique on every Node stays unique wherever they land.
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { MAX_APPS, ownerOfRoute } from "./apps";
import { INGRESS_ROUTE_READ_LIMIT } from "./ingress";

export type NameKind = "container" | "volume" | "network" | "link" | "route";
export interface Claim {
  kind: NameKind;
  name: string;
}

type ServiceNames = { name: string; args: readonly string[]; route?: string };

/** The named volumes a service's Docker args mount: the `name` of each `-v name:/path`. */
export function volumeNames(args: readonly string[]): string[] {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let value: string | undefined;
    if (arg === "-v" || arg === "--volume") value = args[++i];
    else if (arg.startsWith("-v=")) value = arg.slice(3);
    else if (arg.startsWith("--volume=")) value = arg.slice(9);
    if (value !== undefined) names.push(value.split(":")[0]);
  }
  return names;
}

/** Every name an App with these services and links holds. */
export function appClaims(
  app: string,
  services: readonly ServiceNames[],
  links: ReadonlyArray<{ name: string }>,
): Claim[] {
  const claims: Claim[] = [{ kind: "network", name: `${app}-net` }];
  for (const s of services) {
    // A built image is `<registry>/<app>-<service>:<tag>`, the container's join, so the container
    // claim covers the image repository too.
    claims.push({ kind: "container", name: `${app}-${s.name}` });
    for (const volume of volumeNames(s.args)) claims.push({ kind: "volume", name: volume });
    if (s.route !== undefined) claims.push({ kind: "route", name: s.route });
  }
  for (const l of links) claims.push({ kind: "link", name: l.name });
  return claims;
}

const key = (c: Claim) => `${c.kind}:${c.name}`;
const describe = (kind: NameKind) =>
  kind === "link" ? "mesh link" : kind === "route" ? "route label" : `${kind} name`;

/**
 * Who holds each name, other than `app`. A holder is an App name, or a phrase for something that
 * is not an App (a standalone link, a route claimed twice).
 */
async function heldByOthers(ctx: QueryCtx, app: string) {
  const held = new Map<string, string>();
  const hold = (holder: string, claims: Claim[]) => {
    for (const c of claims) if (!held.has(key(c))) held.set(key(c), holder);
  };
  const apps = await ctx.db.query("apps").take(MAX_APPS + 1);
  for (const row of apps)
    if (row.name !== app) hold(`App "${row.name}"`, appClaims(row.name, row.services, row.links));

  const routes = await ctx.db.query("appRoutes").take(INGRESS_ROUTE_READ_LIMIT);
  for (const route of routes) {
    const owner = ownerOfRoute(route, apps);
    if (owner === "ambiguous") {
      held.set(key({ kind: "route", name: route.name }), "more than one App");
      continue;
    }
    if (owner.app === app) continue;
    const claims: Claim[] = [{ kind: "route", name: route.name }];
    // A single-container App the Hub deployed runs one container named after its label.
    if (owner.service === undefined) claims.push({ kind: "container", name: route.name });
    hold(`App "${owner.app}"`, claims);
  }

  // Runs that have a plan and have not committed it: their names are about to be held.
  for (const stage of ["building", "deploying", "linking"] as const) {
    const runs: Doc<"appDeployments">[] = await ctx.db
      .query("appDeployments")
      .withIndex("by_stage", (q) => q.eq("stage", stage))
      .take(100);
    for (const run of runs)
      if (run.app !== app && run.plan !== undefined)
        hold(`App "${run.app}"`, appClaims(run.app, run.plan.services, run.plan.links));
  }

  const standalone = await ctx.db.query("meshLinks").take(1000);
  for (const link of standalone)
    hold(`the standalone link "${link.name}"`, [{ kind: "link", name: link.name }]);
  return held;
}

/**
 * Why the plan for `app` may not hold its names, or null when it may. Also refuses a plan whose own
 * link names collide, which truncation can do within one App.
 */
export async function namespaceRefusal(
  ctx: QueryCtx,
  app: string,
  plan: { services: readonly ServiceNames[]; links: ReadonlyArray<{ name: string; need: string }> },
): Promise<string | null> {
  const needOf = new Map<string, string>();
  for (const l of plan.links) {
    const other = needOf.get(l.name);
    if (other !== undefined && other !== l.need)
      return `App "${app}": the dependencies "${other}" and "${l.need}" both get the mesh link name "${l.name}"; shorten one of them`;
    needOf.set(l.name, l.need);
  }
  const held = await heldByOthers(ctx, app);
  for (const claim of appClaims(app, plan.services, plan.links)) {
    const holder = held.get(key(claim));
    if (holder !== undefined)
      return `App "${app}" cannot use the ${describe(claim.kind)} "${claim.name}": ${holder} already holds it. Rename the App, or the service, volume or dependency that derives it`;
  }
  return null;
}
