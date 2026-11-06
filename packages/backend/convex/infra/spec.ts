// The App spec (`erainfra.yaml` or `portless.yaml` at the repository root), parsed and validated in
// Convex for the deploy pipeline. A port of the Hub's apps/hub/src/runtime/spec.ts with the same
// rules and the same error messages, written without zod so the backend needs only the YAML parser
// the Hub already uses. The build Node returns the file's text; it never interprets it.
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
//       image: 127.0.0.1:61050/postgres:16
//       port: 5432
//       volumes: [pgdata:/var/lib/postgresql/data]
//       node: big-box              # optional placement (default: the deploy's default Node)
import { parse as parseYaml } from "yaml";
import { isRouteLabel } from "./ingress";

const LABEL = /^[a-z0-9][a-z0-9-]{0,62}$/;
// name:/abs/path, named volumes only. A spec comes from a repository, and a host bind mount would
// hand the repository's authors the Node's filesystem.
const VOLUME = /^[a-z0-9][a-z0-9-]{0,62}:\/[^\s:]+$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVICE_KEYS = new Set([
  "build",
  "image",
  "port",
  "route",
  "env",
  "volumes",
  "node",
  "needs",
]);

/** The largest spec file the pipeline accepts from a build Node. */
export const MAX_SPEC_BYTES = 64 * 1024;

export interface SpecService {
  name: string;
  build?: string;
  image?: string;
  port?: number;
  route?: string;
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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(path: string, message: string): SpecResult {
  return { ok: false, error: `portless.yaml: ${path || "(root)"}: ${message}` };
}

type Raw = {
  build?: string;
  image?: string;
  port?: number;
  route?: boolean | string;
  env?: Record<string, string>;
  volumes?: string[];
  node?: string;
  needs?: string[];
};

function checkService(name: string, value: unknown): { ok: true; raw: Raw } | SpecResult {
  const at = `services.${name}`;
  if (!LABEL.test(name)) return fail(at, "lowercase alphanumeric + dashes");
  if (!isObject(value)) return fail(at, "expected an object");
  for (const key of Object.keys(value))
    if (!SERVICE_KEYS.has(key)) return fail(at, `Unrecognized key: "${key}"`);
  const raw: Raw = {};
  if (value.build !== undefined) {
    if (typeof value.build !== "string" || value.build.length > 255)
      return fail(`${at}.build`, "expected a string of at most 255 characters");
    raw.build = value.build;
  }
  if (value.image !== undefined) {
    if (typeof value.image !== "string" || value.image.length < 1 || value.image.length > 512)
      return fail(`${at}.image`, "expected a string of 1 to 512 characters");
    raw.image = value.image;
  }
  if (value.port !== undefined) {
    const port = value.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)
      return fail(`${at}.port`, "expected an integer from 1 to 65535");
    raw.port = port;
  }
  if (value.route !== undefined) {
    if (typeof value.route === "boolean") raw.route = value.route;
    else if (typeof value.route === "string" && LABEL.test(value.route)) raw.route = value.route;
    else return fail(`${at}.route`, "lowercase alphanumeric + dashes");
  }
  if (value.env !== undefined) {
    if (!isObject(value.env)) return fail(`${at}.env`, "expected an object");
    const env: Record<string, string> = {};
    for (const [key, v] of Object.entries(value.env)) {
      if (!ENV_KEY.test(key)) return fail(`${at}.env.${key}`, "a valid env var name");
      if (typeof v !== "string" || v.length > 32768)
        return fail(`${at}.env.${key}`, "expected a string of at most 32768 characters");
      env[key] = v;
    }
    raw.env = env;
  }
  if (value.volumes !== undefined) {
    if (!Array.isArray(value.volumes) || value.volumes.length > 16)
      return fail(`${at}.volumes`, "expected at most 16 volumes");
    for (const [i, v] of value.volumes.entries())
      if (typeof v !== "string" || !VOLUME.test(v))
        return fail(
          `${at}.volumes.${i}`,
          'volumes are "name:/container/path" (named volumes only)',
        );
    raw.volumes = value.volumes as string[];
  }
  if (value.node !== undefined) {
    if (typeof value.node !== "string" || value.node.length < 1 || value.node.length > 128)
      return fail(`${at}.node`, "expected a string of 1 to 128 characters");
    raw.node = value.node;
  }
  if (value.needs !== undefined) {
    if (!Array.isArray(value.needs) || value.needs.length > 16)
      return fail(`${at}.needs`, "expected at most 16 dependencies");
    for (const [i, v] of value.needs.entries())
      if (typeof v !== "string" || !LABEL.test(v))
        return fail(`${at}.needs.${i}`, "lowercase alphanumeric + dashes");
    raw.needs = value.needs as string[];
  }
  return { ok: true, raw };
}

/**
 * Parse, validate and normalize a spec. `fallbackApp` names the App when the spec does not. Every
 * cross-reference (needs, route ports, build/image exclusivity) is checked here, so the planner can
 * trust the result.
 */
export function parseSpec(yamlText: string, fallbackApp: string): SpecResult {
  if (new TextEncoder().encode(yamlText).length > MAX_SPEC_BYTES)
    return { ok: false, error: `portless.yaml is larger than ${MAX_SPEC_BYTES} bytes` };
  let doc: unknown;
  try {
    // A small spec cannot expand into a large document through aliases.
    doc = parseYaml(yamlText, { maxAliasCount: 100 });
  } catch (e) {
    return { ok: false, error: `portless.yaml is not valid YAML: ${(e as Error).message}` };
  }
  if (!isObject(doc)) return fail("", "expected an object");
  for (const key of Object.keys(doc))
    if (key !== "app" && key !== "services") return fail("", `Unrecognized key: "${key}"`);
  if (doc.app !== undefined && (typeof doc.app !== "string" || !LABEL.test(doc.app)))
    return fail("app", "lowercase alphanumeric + dashes");
  if (!isObject(doc.services)) return fail("services", "expected an object");
  const app = (doc.app as string | undefined) ?? fallbackApp;
  if (!LABEL.test(app))
    return { ok: false, error: `app name "${app}" must be lowercase alphanumeric + dashes` };

  const names = Object.keys(doc.services);
  if (names.length === 0) return { ok: false, error: "portless.yaml: define at least one service" };
  if (names.length > 20) return { ok: false, error: "portless.yaml: at most 20 services" };
  const raws = new Map<string, Raw>();
  for (const name of names) {
    const checked = checkService(name, doc.services[name]);
    if (!("raw" in checked)) return checked;
    raws.set(name, checked.raw);
  }

  const routedNames = names.filter((n) => raws.get(n)!.route);
  const services: SpecService[] = [];
  for (const name of names) {
    const s = raws.get(name)!;
    if (!!s.build === !!s.image)
      return { ok: false, error: `service "${name}": set exactly one of build / image` };
    if (s.build !== undefined && (s.build.startsWith("/") || s.build.split("/").includes(".."))) {
      return {
        ok: false,
        error: `service "${name}": build must be a relative dir inside the repo`,
      };
    }
    // route:true is the App name when it is the only routed service, else <app>-<service>.
    let route: string | undefined;
    if (s.route === true) route = routedNames.length === 1 ? app : `${app}-${name}`;
    else if (typeof s.route === "string") route = s.route;
    // A gateway serves `<label>.<zone>` only for a DNS label (ingress.ts), and skips any other
    // route row, so a deploy that routed at one would report a URL nothing answers.
    if (route !== undefined && !isRouteLabel(route))
      return { ok: false, error: routeLabelError(name, route, s.route === true) };
    if (route && !s.port)
      return {
        ok: false,
        error: `service "${name}": route requires port (what should the URL proxy to?)`,
      };
    for (const need of s.needs ?? []) {
      if (!names.includes(need))
        return { ok: false, error: `service "${name}": needs unknown service "${need}"` };
      if (need === name) return { ok: false, error: `service "${name}": cannot need itself` };
      if (!raws.get(need)!.port)
        return {
          ok: false,
          error: `service "${need}": needs a port (it is a dependency of "${name}")`,
        };
    }
    services.push({
      name,
      ...(s.build === undefined ? {} : { build: s.build }),
      ...(s.image === undefined ? {} : { image: s.image }),
      ...(s.port === undefined ? {} : { port: s.port }),
      ...(route === undefined ? {} : { route }),
      env: s.env ?? {},
      volumes: s.volumes ?? [],
      ...(s.node === undefined ? {} : { node: s.node }),
      needs: s.needs ?? [],
    });
  }
  const routes = services.map((s) => s.route).filter(Boolean);
  if (new Set(routes).size !== routes.length)
    return { ok: false, error: "route labels must be unique within the app" };
  return { ok: true, spec: { app, services } };
}

/**
 * Why a route label no gateway can serve is refused. `derived` is a `route: true` label, whose
 * text the spec's author never wrote.
 */
export function routeLabelError(service: string, route: string, derived: boolean): string {
  const rule =
    "a route label is a DNS label: at most 63 characters, lowercase letters, digits and dashes, " +
    "starting and ending with a letter or digit";
  if (!derived) return `service "${service}": route "${route}" is not served: ${rule}`;
  return (
    `service "${service}": route: true gives the label "${route}" (${route.length} characters), ` +
    `which is not served: ${rule}. Name the label explicitly (route: <label>)`
  );
}

/**
 * The spec of a repository with no spec file: one service built from the root and routed at the
 * App name. `port` comes from the binding or the deploy request. The pipeline refuses an App name
 * that is not a route label (routeLabelError) before planning it.
 */
export function implicitSpec(app: string, port: number): AppSpec {
  return {
    app,
    services: [{ name: "web", build: ".", port, route: app, env: {}, volumes: [], needs: [] }],
  };
}

/** Env-var prefix for an injected dependency: "my-db" → "MY_DB". */
export function envName(service: string): string {
  return service.toUpperCase().replace(/-/g, "_");
}
