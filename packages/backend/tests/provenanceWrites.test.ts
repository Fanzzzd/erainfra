// @vitest-environment node
// Every Convex write to a table the Hub importer also writes must record its provenance
// (convex/infra/hubProvenance.ts). A write that does not is overwritten by the next Hub import. This
// test reads every module under convex/ with the TypeScript type checker, finds each
// `<ctx>.db.insert|patch|replace|delete` call whose target is one of those tables, and fails with the
// file and line of any that neither stamps provenance at the call nor is on the short list below.
//
// The type checker decides which table a `patch(id, …)` or `delete(id)` writes from the type of
// `id` (`Id<"apps">`), so a write is caught however its row was found. The repository typechecks with
// TypeScript 7, which ships no compiler API; `typescript-compiler-api` is TypeScript 5.9 under
// another name, used only here.
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript-compiler-api";
import { describe, expect, it } from "vitest";

const CONVEX_DIR = join(dirname(fileURLToPath(import.meta.url)), "../convex");

/** The tables hubImport.ts writes rows of and Convex writes too. */
const OWNED_TABLES = new Set([
  "apps",
  "appRoutes",
  "meshLinks",
  "portAllocations",
  "appSecrets",
  "gitBindings",
]);

/** Calls that stamp a row: `provenance: convexWrite(now)` or `provenance: provenanceFor(now, hub)`. */
const STAMPS = new Set(["convexWrite", "provenanceFor"]);

/**
 * Writes that carry no stamp at the call, each reviewed. Keyed `<file> <function> <method> <table>`.
 * An insert or replace here must take its provenance from the helper's caller; a delete must leave a
 * tombstone (or be covered by one) so the importer does not bring the row back.
 */
const ALLOWED: Record<string, string> = {
  "infra/apps.ts upsertApp insert apps": "writes `fields`, which carries provenanceFor(now, hub)",
  "infra/apps.ts upsertApp replace apps": "writes `fields`, which carries provenanceFor(now, hub)",
  "infra/apps.ts upsertRoute insert appRoutes": "writes `fields` with provenanceFor(now, hub)",
  "infra/apps.ts upsertRoute replace appRoutes": "writes `fields` with provenanceFor(now, hub)",
  "infra/apps.ts upsertMeshLink insert meshLinks": "writes `fields` with provenanceFor(now, hub)",
  "infra/apps.ts upsertMeshLink replace meshLinks": "writes `fields` with provenanceFor(now, hub)",
  "infra/ports.ts insertAllocation insert portAllocations":
    "its `provenance` parameter is required; allocatePort and claimPort stamp it",
  "infra/ports.ts releaseAppPorts delete portAllocations":
    "frees an App's ports; removeApp tombstones the App, and the importer skips ports of a tombstoned App",
  "infra/operator.ts removeApp delete appRoutes":
    "removeApp tombstones the App the route belongs to",
  "infra/operator.ts removeApp delete apps": "removeApp tombstones the App",
  "infra/operator.ts removeLink delete meshLinks": "removeLink tombstones the link",
  "infra/secrets.ts unsetSecret delete appSecrets": "unsetSecret tombstones the variable",
  "infra/git.ts unbindBranch delete gitBindings": "unbindBranch tombstones the branch",
};

type Write = { site: string; key: string; stamped: boolean };

function convexProgram() {
  const configPath = join(CONVEX_DIR, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, CONVEX_DIR);
  return ts.createProgram(parsed.fileNames, parsed.options);
}

/** The name a write is reported under: its enclosing function, or the export it is the body of. */
function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined)
      return at.name.getText();
    if (ts.isVariableDeclaration(at)) return at.name.getText();
  }
  return "<module>";
}

/** Every table a type names: `Id<"apps">`, or a union of ids. */
function tablesOfType(checker: ts.TypeChecker, type: ts.Type): string[] {
  const members = type.isUnion() ? type.types : [type];
  return members.flatMap((member) => {
    const literal = member.isStringLiteral() ? member.value : null;
    if (literal !== null) return [literal];
    const match = /\bId<"(\w+)">/.exec(checker.typeToString(member));
    return match === null ? [] : [match[1]];
  });
}

function stampsProvenance(checker: ts.TypeChecker, value: ts.Expression | undefined) {
  if (value === undefined || !ts.isObjectLiteralExpression(value)) return false;
  const isStamp = (expr: ts.Expression | undefined) =>
    expr !== undefined &&
    ts.isCallExpression(expr) &&
    ts.isIdentifier(expr.expression) &&
    STAMPS.has(expr.expression.text);
  return value.properties.some((property) => {
    if (property.name === undefined || property.name.getText() !== "provenance") return false;
    if (ts.isPropertyAssignment(property)) return isStamp(property.initializer);
    if (ts.isShorthandPropertyAssignment(property)) {
      const declaration = checker.getShorthandAssignmentValueSymbol(property)?.valueDeclaration;
      return (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        isStamp(declaration.initializer)
      );
    }
    return false;
  });
}

/** Every write to an owned table in convex/, with whether it stamps provenance at the call. */
function ownedTableWrites(): { writes: Write[]; unresolved: string[] } {
  const program = convexProgram();
  const checker = program.getTypeChecker();
  const writes: Write[] = [];
  const unresolved: string[] = [];
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.startsWith(CONVEX_DIR) || source.fileName.includes("/_generated/"))
      continue;
    const file = relative(CONVEX_DIR, source.fileName);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ["insert", "patch", "replace", "delete"].includes(node.expression.name.text) &&
        ts.isPropertyAccessExpression(node.expression.expression) &&
        node.expression.expression.name.text === "db"
      ) {
        const method = node.expression.name.text;
        const [first] = node.arguments;
        const site = `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        // The first argument names the table: `insert(table, value)`, Convex's table-first
        // `patch(table, id, value)`, or an id whose type is `Id<table>`.
        const tables = tablesOfType(checker, checker.getTypeAtLocation(first));
        if (tables.length === 0) unresolved.push(`${site} ${method}`);
        const value = method === "delete" ? undefined : node.arguments[node.arguments.length - 1];
        for (const table of tables.filter((t) => OWNED_TABLES.has(t))) {
          writes.push({
            site,
            key: `${file} ${enclosingName(node)} ${method} ${table}`,
            stamped: stampsProvenance(checker, value),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { writes, unresolved };
}

describe("writes to tables the Hub importer also writes", () => {
  const { writes, unresolved } = ownedTableWrites();

  it("finds the writes it is meant to police", () => {
    // A scan that resolved nothing would pass vacuously.
    expect(writes.length).toBeGreaterThan(Object.keys(ALLOWED).length);
    expect(unresolved).toEqual([]);
  });

  it("stamp provenance at the call, or are on the reviewed list", () => {
    const unstamped = writes
      .filter((w) => !w.stamped && !(w.key in ALLOWED))
      .map((w) => `${w.site} ${w.key.split(" ").slice(1).join(" ")}`);
    expect(
      unstamped,
      "Each of these writes neither records provenance (provenance: convexWrite(now)) nor is " +
        "reviewed in ALLOWED; the next Hub import would overwrite or restore the row",
    ).toEqual([]);
  });

  it("keeps the reviewed list free of entries that no longer match a write", () => {
    const seen = new Set(writes.map((w) => w.key));
    expect(Object.keys(ALLOWED).filter((key) => !seen.has(key))).toEqual([]);
  });
});
