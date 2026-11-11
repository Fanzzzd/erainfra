import type { HttpRouter } from "convex/server";
import { ConvexError } from "convex/values";

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { httpAction } from "../_generated/server";
import { bearerToken } from "../apiTokenPolicy";
import { deployAppConfig, mintRepoReadToken } from "./githubDeploy";
import { MAX_BODY_BYTES } from "./nodeCommandModel";
import { ENDPOINT_REFUSALS } from "./nodeState";
import { isWellFormedNodeCredential } from "./policy";

/**
 * A spec or build payload from a repository gets a read-only token for that one repository, minted
 * here because a query cannot call GitHub. The claim check already ran in the payload query. With
 * no deploy App configured, or the App not installed on the repository, the Node clones without
 * one, which works for a public repository.
 */
async function withRepoToken(result: unknown) {
  const p = result as { kind?: string; source?: { kind?: string; repo?: string } } | null;
  if ((p?.kind !== "spec" && p?.kind !== "build") || p.source?.kind !== "git") return result;
  const app = deployAppConfig(process.env);
  if (app === null) return result;
  const minted = await mintRepoReadToken({
    app,
    repo: p.source.repo!,
    now: Date.now(),
    fetch: globalThis.fetch,
  });
  if (minted.ok) return { ...p, source: { ...p.source, token: minted.token } };
  if (minted.reason === "not-installed") return result;
  throw new Error("GitHub token unavailable");
}

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
async function bodyObject(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("Body too large");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected object");
  return parsed as Record<string, unknown>;
}
function endpointRefusal(error: unknown) {
  if (!(error instanceof ConvexError)) return undefined;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null || !("code" in data)) return undefined;
  return ENDPOINT_REFUSALS.find((code) => code === data.code);
}
export function registerNodeRoutes(http: HttpRouter) {
  for (const [method, path] of [
    ["GET", "state"],
    ["GET", "commands"],
    ["POST", "heartbeat"],
    ["POST", "endpoint/challenge"],
    ["POST", "endpoint"],
    ["POST", "commands/claim"],
    ["POST", "commands/renew"],
    ["POST", "commands/payload"],
    ["POST", "commands/result"],
    ["POST", "commands/status"],
  ] as const) {
    http.route({
      method,
      path: `/api/v1/nodes/${path}`,
      handler: httpAction(async (ctx, request) => {
        const credential = bearerToken(request.headers.get("Authorization"));
        if (
          !credential ||
          !isWellFormedNodeCredential(credential) ||
          !(await ctx.runQuery(internal.infra.nodes.authenticate, { credential }))
        )
          return response({ error: "unauthorized" }, 401);
        try {
          const url = new URL(request.url);
          const b = method === "POST" ? await bodyObject(request) : {};
          const fields: Record<string, string[]> = {
            state: [],
            commands: [],
            heartbeat: ["version", "commandsBlocked", "journalKeys", "journalKeyLimit"],
            "endpoint/challenge": ["address"],
            endpoint: ["challengeId", "signature"],
            "commands/claim": ["commandId", "owner"],
            "commands/renew": ["commandId", "owner", "epoch"],
            "commands/payload": ["commandId", "owner", "epoch"],
            "commands/result": [
              "commandId",
              "owner",
              "epoch",
              "outcome",
              "spec",
              "output",
              "truncated",
            ],
            "commands/status": ["commandIds"],
          };
          if (
            Object.keys(b).some((k) => !fields[path].includes(k)) ||
            [...url.searchParams.keys()].some((k) => !["cursor", "revision"].includes(k))
          )
            return response({ error: "unknown_field" }, 400);
          const claim = {
            credential,
            commandId: b.commandId as Id<"nodeCommands">,
            owner: b.owner as string,
            epoch: b.epoch as number,
          };
          let result: unknown;
          switch (path) {
            case "heartbeat":
              result = await ctx.runMutation(internal.infra.nodeState.heartbeat, {
                credential,
                version: b.version as string,
                ...(b.commandsBlocked === undefined
                  ? {}
                  : { commandsBlocked: b.commandsBlocked as string }),
                ...(b.journalKeys === undefined ? {} : { journalKeys: b.journalKeys as number }),
                ...(b.journalKeyLimit === undefined
                  ? {}
                  : { journalKeyLimit: b.journalKeyLimit as number }),
              });
              break;
            case "commands/status":
              result = await ctx.runQuery(internal.infra.nodeCommands.statuses, {
                credential,
                commandIds: b.commandIds as string[],
              });
              break;
            case "state":
              result = await ctx.runQuery(internal.infra.nodeState.state, {
                credential,
                revision: url.searchParams.get("revision") ?? undefined,
              });
              break;
            case "commands":
              result = await ctx.runQuery(internal.infra.nodeState.pending, {
                credential,
                cursor: url.searchParams.get("cursor") || null,
              });
              break;
            case "commands/claim":
              result = await ctx.runMutation(internal.infra.nodeCommands.claim, {
                credential,
                commandId: claim.commandId,
                owner: claim.owner,
              });
              break;
            case "commands/renew":
              result = await ctx.runMutation(internal.infra.nodeCommands.renew, claim);
              break;
            case "commands/payload":
              result = await withRepoToken(
                await ctx.runQuery(internal.infra.nodeCommands.payload, claim),
              );
              break;
            case "commands/result":
              result = await ctx.runMutation(internal.infra.nodeCommands.report, {
                ...claim,
                outcome: b.outcome as "success" | "failure" | "unknown",
                ...(b.spec === undefined ? {} : { spec: b.spec as string }),
                ...(b.output === undefined ? {} : { output: b.output as string }),
                ...(b.truncated === undefined ? {} : { truncated: b.truncated as boolean }),
              });
              break;
            case "endpoint/challenge":
              result = await ctx.runMutation(internal.infra.nodeState.challenge, {
                credential,
                address: b.address as { id: string; relay_urls: string[]; direct_addrs: string[] },
              });
              break;
            case "endpoint":
              result = await ctx.runMutation(internal.infra.nodeState.publish, {
                credential,
                challengeId: b.challengeId as Id<"nodeEndpointChallenges">,
                signature: b.signature as string,
              });
              break;
          }
          if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BODY_BYTES)
            return response({ error: "response_too_large" }, 413);
          return response(result);
        } catch (error) {
          // Do not echo validation errors, command data, credential or secret payload into logs or
          // HTTP errors. A revocation that raced the first auth check must still return 401.
          const live = await ctx.runQuery(internal.infra.nodes.authenticate, { credential });
          if (!live) return response({ error: "unauthorized" }, 401);
          // The fixed endpoint refusal codes carry no data, only which operator action is due.
          return response({ error: endpointRefusal(error) ?? "request_refused" }, 409);
        }
      }),
    });
  }
}
