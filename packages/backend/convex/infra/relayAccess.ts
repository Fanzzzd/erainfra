import type { HttpRouter } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { httpAction, internalQuery } from "../_generated/server";
import { sharedSecretAuthorization } from "../controllerHttp";
import { grantable } from "./nodeState";

/**
 * The fleet relay's access check (ADR 0016, item 5; deploy/infra/relay.sh).
 *
 * A fleet relay is n0's iroh-relay with `access.http` pointed here. The relay calls this route
 * once per client connection, after the client has proven its EndpointId in the relay handshake
 * and before it relays anything. iroh-relay 1.4 sends a POST with no body, the id in
 * `X-Iroh-Endpoint-Id` and `Authorization: Bearer <access.http.bearer_token>`, and admits the
 * client only on status 200 with the body `true` (iroh-relay src/main.rs, `HttpAccess`).
 *
 * A client is admitted while it is a Node the mesh would grant anything to (`grantable`): its
 * endpoint key is proven by a signed challenge and it holds a live credential. Enrolling, proving,
 * resetting and revoking therefore apply to the relay at the next connection, with no list to keep.
 * Revocation does not cut a relay connection that is already open, but every sidecar already
 * refuses a peer outside its fleet after the QUIC handshake, so that connection carries nothing.
 *
 * The route needs RELAY_ACCESS_TOKEN (or RELAY_ACCESS_TOKEN_NEXT during a rotation). Without the
 * secret it answers 401 before reading the id, so it tells a stranger nothing about who is in the
 * fleet. With the secret unset it answers 503, which the relay treats as a denial: it fails closed.
 */
export const RELAY_ACCESS_PATH = "/api/v1/relay/access";
export const RELAY_ENDPOINT_ID_HEADER = "X-Iroh-Endpoint-Id";

/** iroh's EndpointId as iroh-relay writes it: 32 bytes, lowercase hex. */
const ENDPOINT_ID = /^[0-9a-f]{64}$/;

export const admits = internalQuery({
  args: { endpointId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { endpointId }) => {
    if (!ENDPOINT_ID.test(endpointId)) return false;
    // nodeState.assertEndpointAvailable keeps an EndpointId on at most one Node; two rows are read
    // so a row that predates that rule cannot hide a second one.
    const nodes = await ctx.db
      .query("nodes")
      .withIndex("by_endpointId", (q) => q.eq("endpointId", endpointId))
      .take(2);
    for (const node of nodes) if ((await grantable(ctx, node)) !== null) return true;
    return false;
  },
});

function answer(allowed: boolean, status: number) {
  return new Response(allowed ? "true" : "false", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export function registerRelayRoutes(http: HttpRouter) {
  http.route({
    method: "POST",
    path: RELAY_ACCESS_PATH,
    handler: httpAction(async (ctx, request) => {
      const verdict = sharedSecretAuthorization(
        request.headers.get("Authorization"),
        process.env.RELAY_ACCESS_TOKEN,
        process.env.RELAY_ACCESS_TOKEN_NEXT,
      );
      if (verdict.status === "not-configured") {
        console.error(
          "The relay access check refused a request because RELAY_ACCESS_TOKEN is not set",
        );
        return answer(false, 503);
      }
      if (verdict.status === "unauthorized") return answer(false, 401);
      const endpointId = request.headers.get(RELAY_ENDPOINT_ID_HEADER) ?? "";
      if (!ENDPOINT_ID.test(endpointId)) return answer(false, 400);
      const allowed = await ctx.runQuery(internal.infra.relayAccess.admits, { endpointId });
      return answer(allowed, allowed ? 200 : 403);
    }),
  });
}
