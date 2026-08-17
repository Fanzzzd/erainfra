// portless.yaml — the declarative deploy unit. Lives at the repo root; the hub reads it at deploy
// time and executes it deterministically: build each service (Dockerfile or nixpacks), place it on
// its node, publish routed services at <route>.<domain>, and wire `needs:` dependencies (same-node →
// docker DNS; cross-node → a mesh link with injected HOST/PORT env). No AI, no judgment calls — how a
// project deploys is written in the project.
//
//   app: myapp                     # optional; defaults to the binding/CLI name
//   services:
//     web:
//       build: .                   # build context dir (or `image: ref` for a prebuilt image)
//       port: 3000                 # container port the service listens on (PORT is injected)
//       route: true                # public URL. true → app name; or an explicit label
//       env: { NODE_ENV: production }
//       needs: [db]                # injects DB_HOST / DB_PORT (same node: docker DNS; cross: mesh)
//     db:
//       image: 127.0.0.1:61050/postgres:16   # from YOUR registry (mirror it once with image.sh)
//       port: 5432
//       volumes: [pgdata:/var/lib/postgresql/data]
//       node: big-box              # optional placement (default: the deploy's default node)
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
const label = z.string().regex(LABEL, "lowercase alphanumeric + dashes");
// name:/abs/path — named volumes only. Host bind mounts are deliberately rejected: a spec comes from
// a repo, and letting it mount arbitrary node paths would hand repo authors the node's filesystem.
const volumeRef = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,62}:\/[^\s:]+$/,
    'volumes are "name:/container/path" (named volumes only)',
  );
const envKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

const serviceSchema = z
  .object({
    build: z.string().max(255).optional(), // context dir within the repo
    image: z.string().min(1).max(512).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    route: z.union([z.boolean(), label]).optional(),
    env: z
      .record(z.string().regex(envKey, "a valid env var name"), z.string().max(32768))
      .optional(),
    volumes: z.array(volumeRef).max(16).optional(),
    node: z.string().min(1).max(128).optional(),
    needs: z.array(label).max(16).optional(),
  })
  .strict();

const specSchema = z
  .object({
    app: label.optional(),
    services: z.record(label, serviceSchema),
  })
  .strict();

export interface SpecService {
  name: string;
  build?: string; // exactly one of build/image after validation
  image?: string;
  port?: number;
  route?: string; // resolved label (route:true handled here)
  env: Record<string, string>;
  volumes: string[];
  node?: string;
  needs: string[];
}

export interface AppSpec {
  app: string;
  services: SpecService[];
}

export type SpecResult = { ok: true; spec: AppSpec } | { ok: false; error: string };

// Parse + validate + normalize a portless.yaml. `fallbackApp` names the app when the spec doesn't
// (the git binding name / CLI directory name). All cross-references (needs, route ports, build/image
// exclusivity) are checked HERE so the deploy pipeline can trust the spec blindly.
export function parseSpec(yamlText: string, fallbackApp: string): SpecResult {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (e) {
    return { ok: false, error: `portless.yaml is not valid YAML: ${(e as Error).message}` };
  }
  const parsed = specSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      error: `portless.yaml: ${first.path.join(".") || "(root)"}: ${first.message}`,
    };
  }
  const app = parsed.data.app ?? fallbackApp;
  if (!LABEL.test(app))
    return { ok: false, error: `app name "${app}" must be lowercase alphanumeric + dashes` };

  const names = Object.keys(parsed.data.services);
  if (names.length === 0) return { ok: false, error: "portless.yaml: define at least one service" };
  if (names.length > 20) return { ok: false, error: "portless.yaml: at most 20 services" };

  const services: SpecService[] = [];
  const routedNames = names.filter((n) => parsed.data.services[n].route);
  for (const name of names) {
    const s = parsed.data.services[name];
    if (!!s.build === !!s.image)
      return { ok: false, error: `service "${name}": set exactly one of build / image` };
    if (s.build !== undefined && (s.build.startsWith("/") || s.build.split("/").includes(".."))) {
      return {
        ok: false,
        error: `service "${name}": build must be a relative dir inside the repo`,
      };
    }
    // route:true resolves to the app name when it's the only routed service, else <app>-<service> —
    // deterministic URLs with no coordination needed between services.
    let route: string | undefined;
    if (s.route === true) route = routedNames.length === 1 ? app : `${app}-${name}`;
    else if (typeof s.route === "string") route = s.route;
    if (route && !s.port)
      return {
        ok: false,
        error: `service "${name}": route requires port (what should the URL proxy to?)`,
      };
    for (const need of s.needs ?? []) {
      if (!names.includes(need))
        return { ok: false, error: `service "${name}": needs unknown service "${need}"` };
      if (need === name) return { ok: false, error: `service "${name}": cannot need itself` };
      if (!parsed.data.services[need].port)
        return {
          ok: false,
          error: `service "${need}": needs a port (it is a dependency of "${name}")`,
        };
    }
    services.push({
      name,
      build: s.build,
      image: s.image,
      port: s.port,
      route,
      env: s.env ?? {},
      volumes: s.volumes ?? [],
      node: s.node,
      needs: s.needs ?? [],
    });
  }
  const routes = services.map((s) => s.route).filter(Boolean);
  if (new Set(routes).size !== routes.length)
    return { ok: false, error: "route labels must be unique within the app" };
  return { ok: true, spec: { app, services } };
}

// The implicit spec for a repo with NO portless.yaml: one service, built from the repo root, routed
// at the app name. `port` comes from the binding/CLI (there is nothing else to read it from).
export function implicitSpec(app: string, port: number): AppSpec {
  return {
    app,
    services: [{ name: "web", build: ".", port, route: app, env: {}, volumes: [], needs: [] }],
  };
}

// Env-var prefix for an injected dependency: "my-db" → "MY_DB".
export function envName(service: string): string {
  return service.toUpperCase().replace(/-/g, "_");
}
