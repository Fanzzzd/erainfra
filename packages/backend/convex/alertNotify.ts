// What an alert notification looks like on the wire, how it is signed, and when a failed send is
// retried. Pure, so the payloads and the signature are tested byte for byte.

export const SIGNATURE_HEADER = "X-EraInfra-Signature";
export const EVENT_HEADER = "X-EraInfra-Event";
export const DELIVERY_HEADER = "X-EraInfra-Delivery";

/** Sends per delivery, counting the first. With the backoff below the last is about an hour in. */
export const MAX_DELIVERY_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60_000;
export const DELIVERY_TIMEOUT_MS = 10_000;

export type NotificationEvent = "firing" | "resolved" | "test";

export type NotificationContent = {
  event: NotificationEvent;
  rule: { id: string; name: string; kind: string; condition: string; profile: string | null };
  incident: {
    id: string;
    subject: string;
    summary: string;
    since: number;
    firedAt: number | null;
    resolvedAt: number | null;
  };
  sentAt: number;
};

function isoOrNull(timestamp: number | null) {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

/**
 * The generic webhook body. `version` lets a receiver refuse a shape it does not know; fields are
 * only ever added within a version.
 */
export function webhookBody(content: NotificationContent) {
  return JSON.stringify({
    version: 1,
    event: `alert.${content.event}`,
    rule: content.rule,
    incident: {
      ...content.incident,
      status: content.event === "test" ? "test" : content.event,
      since: isoOrNull(content.incident.since),
      firedAt: isoOrNull(content.incident.firedAt),
      resolvedAt: isoOrNull(content.incident.resolvedAt),
    },
    sentAt: isoOrNull(content.sentAt),
  });
}

// Slack treats &, < and > as control characters in message text.
function slackEscape(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLACK_HEADLINE: Record<NotificationEvent, string> = {
  firing: ":rotating_light: Firing",
  resolved: ":white_check_mark: Resolved",
  test: ":wave: Test",
};

/** A Slack incoming-webhook message: `text` for notifications, one section block for the channel. */
export function slackBody(content: NotificationContent) {
  const headline = `${SLACK_HEADLINE[content.event]}: ${slackEscape(content.rule.name)}`;
  const lines = [
    `*${headline}*`,
    slackEscape(content.incident.summary),
    `Subject \`${slackEscape(content.incident.subject)}\` · ${slackEscape(content.rule.condition)}`,
  ];
  return JSON.stringify({
    text: `${headline}: ${slackEscape(content.incident.summary)}`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }],
  });
}

function toHex(bytes: ArrayBuffer) {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The signature header value, Stripe's scheme: `t=<unix seconds>,v1=<hex HMAC-SHA256>` over
 * `"<t>.<body>"`, keyed with the destination's whole signing secret. Covering the timestamp lets a
 * receiver refuse a replay older than its tolerance, which a body-only signature (GitHub's
 * X-Hub-Signature-256) cannot.
 */
export async function signWebhook(secret: string, timestampSeconds: number, body: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestampSeconds}.${body}`),
  );
  return `t=${timestampSeconds},v1=${toHex(mac)}`;
}

export type SendOutcome =
  | { kind: "delivered"; statusCode: number }
  | { kind: "retry"; statusCode?: number; error: string; retryAfterMs?: number }
  | { kind: "permanent"; statusCode: number; error: string };

/**
 * 2xx is delivered. 408, 429 and 5xx are the receiver's temporary trouble and are retried; any
 * other status means the request itself is wrong (a deleted Slack webhook answers 404 or 410) and
 * resending the same bytes cannot fix it.
 */
export function classifyResponse(statusCode: number, retryAfterHeader: string | null): SendOutcome {
  if (statusCode >= 200 && statusCode < 300) return { kind: "delivered", statusCode };
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    const seconds = Number(retryAfterHeader);
    return {
      kind: "retry",
      statusCode,
      error: `HTTP ${statusCode}`,
      ...(Number.isFinite(seconds) && seconds > 0
        ? { retryAfterMs: Math.min(seconds * 1_000, MAX_BACKOFF_MS) }
        : {}),
    };
  }
  return { kind: "permanent", statusCode, error: `HTTP ${statusCode}` };
}

/**
 * Delay before send number `attempts + 1`: 30 s doubling to an hour, with up to 20% jitter so
 * deliveries that failed together do not retry together. A receiver's Retry-After wins when it
 * asks for longer.
 */
export function deliveryBackoffMs(attempts: number, random: number, retryAfterMs?: number) {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  const jittered = Math.round(exponential * (1 + 0.2 * random));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** Enough of a URL to recognise it in the dashboard without revealing its secret path. */
export function urlHint(raw: string) {
  const url = new URL(raw);
  const tail = url.pathname.replace(/\/+$/, "").slice(-4);
  return `${url.protocol}//${url.host}/…${tail.length === 0 ? "" : tail}`;
}

/**
 * Why a destination URL is refused, or undefined. Only https leaves the deployment. A Slack
 * destination is not pinned to hooks.slack.com, because Mattermost, Rocket.Chat and Discord's
 * `/slack` endpoint accept the same message format at their own hosts.
 */
export function destinationUrlError(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Enter a full URL, starting with https://";
  }
  if (url.protocol !== "https:") return "The URL must use https";
  if (url.username !== "" || url.password !== "") {
    return "Remove the user name and password from the URL";
  }
  return undefined;
}
