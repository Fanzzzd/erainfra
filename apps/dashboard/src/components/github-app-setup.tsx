import { type ReactNode, useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CircleCheck, ExternalLink, GitPullRequest, KeyRound, TriangleAlert } from "lucide-react";
import { api } from "@erainfra/backend/api";
import {
  DISCONNECT_CONFIRMATION,
  LEGACY_REMOVAL_COMMANDS,
} from "@erainfra/backend/githubAppConfig";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { convexSiteUrl } from "@/lib/convex-site";
import { cn } from "@/lib/utils";

const CALLBACK_ERRORS: Record<string, string> = {
  missing_code: "GitHub did not return a registration code. Start the flow again.",
  state_unknown: "That setup link is not valid. Start the flow again.",
  state_consumed: "That setup link was already used. Start the flow again.",
  state_expired: "That setup link expired. Start the flow again.",
  conversion_failed:
    "GitHub rejected the credential exchange. The setup code is single-use and short-lived — start the flow again, and check the Convex logs if it keeps failing.",
};

type CallbackResult = { ok: true } | { ok: false; message: string };

// The Manifest callback redirects here with a result; read it once, then strip
// it from the URL so a refresh does not replay the banner.
function useCallbackResult() {
  const [result, setResult] = useState<CallbackResult>();

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const setup = params.get("setup");
    if (setup === null) return;

    setResult(
      setup === "created"
        ? { ok: true }
        : {
            ok: false,
            message:
              CALLBACK_ERRORS[params.get("reason") ?? ""] ?? "GitHub App setup did not complete.",
          },
    );
    params.delete("setup");
    params.delete("reason");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query.length > 0 ? `?${query}` : ""}`,
    );
  }, []);

  return result;
}

const SOURCE_NOTE: Record<string, string> = {
  pat: "This deployment authenticates with the legacy GITHUB_PAT. Connect an App to migrate — once connected, the App takes precedence and the PAT is only used for repositories the App does not cover.",
  envApp:
    "This deployment uses a hand-registered App from GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY. Connecting an App here replaces it: stored credentials take precedence over the environment.",
};

function Panel({ tone, children }: { tone: "neutral" | "warn"; children: ReactNode }) {
  return (
    <section
      className={cn(
        "rounded-lg border px-4 py-3.5",
        tone === "warn" ? "border-warning/25 bg-warning/[0.04]" : "border-border bg-card",
      )}
      aria-labelledby="github-app-heading"
    >
      {children}
    </section>
  );
}

/**
 * The migration is not over when the App connects.
 *
 * `GITHUB_WEBHOOK_SECRET` stays an accepted signing key until it is removed by
 * hand, and nothing else in the product ever says so. Silent once the legacy
 * credentials are gone.
 */
function CutoverWarning({
  webhookSecretConfigured,
  patConfigured,
}: {
  webhookSecretConfigured: boolean;
  patConfigured: boolean;
}) {
  return (
    <div role="status" className="mt-3 border-t border-border pt-3 text-xs leading-5 text-warning">
      <p className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Finish the cut-over: legacy credentials are still accepted
      </p>
      <p className="mt-1.5 opacity-85">
        {webhookSecretConfigured && (
          <>
            <code className="text-warning-foreground">GITHUB_WEBHOOK_SECRET</code> is still set, so
            it remains a valid signing key for{" "}
            <code className="text-warning-foreground">/github/webhook</code> — anyone holding it,
            including whoever configured the repository webhooks you are retiring, can submit
            deliveries this deployment trusts.{" "}
          </>
        )}
        {patConfigured && (
          <>
            <code className="text-warning-foreground">GITHUB_PAT</code> is still set and still
            serves jobs that arrive without an App installation ID.{" "}
          </>
        )}
        Retire the per-repository webhooks and let in-flight jobs finish first, then remove them:
      </p>
      <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-sunken p-2.5 font-mono text-[11px] leading-5 text-secondary-foreground">
        <code>{LEGACY_REMOVAL_COMMANDS.join("\n")}</code>
      </pre>
    </div>
  );
}

/**
 * Two steps, because the copy is the safeguard: the first click only reveals
 * what disconnecting actually does. Nothing is sent until the operator confirms.
 */
function DisconnectConfirm({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div
      role="alertdialog"
      aria-label="Confirm disconnect"
      className="mt-3 rounded-md border border-destructive/25 bg-destructive/[0.06] px-3 py-3 text-xs leading-5 text-destructive"
    >
      <p className="font-medium">Disconnect this GitHub App?</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 opacity-85">
        <li>
          This only forgets the credentials stored here. The App and every installation stay on
          GitHub, and it keeps sending webhooks.
        </li>
        <li>
          Those deliveries will no longer verify, so App-authenticated jobs stop reaching this
          deployment and queued work can stall.
        </li>
        <li>
          The private key cannot be recovered from GitHub. Reconnecting registers a second App.
        </li>
      </ul>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
          Keep it connected
        </Button>
        <Button variant="ghost" size="sm" onClick={onConfirm} disabled={busy}>
          {busy ? "Disconnecting…" : "Yes, disconnect"}
        </Button>
      </div>
    </div>
  );
}

export function GithubAppSetup() {
  const status = useQuery(api.githubApp.status);
  const beginSetup = useMutation(api.githubApp.beginSetup);
  const disconnect = useMutation(api.githubApp.disconnect);
  const callbackResult = useCallbackResult();
  const orgFieldId = useId();
  const [org, setOrg] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string>();

  if (status === undefined) return null;

  async function confirmDisconnect() {
    setDisconnecting(true);
    setError(undefined);
    try {
      await disconnect({ confirmation: DISCONNECT_CONFIRMATION });
      setConfirmingDisconnect(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not disconnect the GitHub App");
    } finally {
      setDisconnecting(false);
    }
  }

  async function createApp() {
    setSubmitting(true);
    setError(undefined);
    try {
      const { state } = await beginSetup({});
      const target = new URL(`${convexSiteUrl()}/github/app/new`);
      target.searchParams.set("state", state);
      if (org.trim().length > 0) {
        target.searchParams.set("org", org.trim());
      }
      window.location.href = target.toString();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not start GitHub App setup");
      setSubmitting(false);
    }
  }

  // Only a Manifest-created App suppresses the offer to connect one; every
  // other source (none, legacy PAT, hand-registered App) keeps it reachable so
  // an operator can always migrate onto a managed App.
  const app = status.app;
  if (!status.canConnect && app !== null) {
    return (
      <Panel tone="neutral">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
            <div className="min-w-0">
              <h2 id="github-app-heading" className="text-sm font-medium text-secondary-foreground">
                GitHub App connected
              </h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {app.name} · app ID {app.appId} · client ID{" "}
                <code className="font-mono">{app.clientId}</code>
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                Webhook and JIT runner credentials are stored in this deployment and never leave it.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={app.installUrl} target="_blank" rel="noreferrer">
                Install on repositories
                <ExternalLink />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmingDisconnect(true)}
              disabled={confirmingDisconnect}
              title="Forget the credentials stored here. The app itself stays on GitHub."
            >
              Disconnect
            </Button>
          </div>
        </div>
        {callbackResult?.ok === true && (
          <>
            <Separator className="my-3" />
            <p className="text-xs text-success">
              App created. Install it on the repositories EraInfra should serve.
            </p>
          </>
        )}
        {status.legacy.cutoverIncomplete && (
          <CutoverWarning
            webhookSecretConfigured={status.legacy.webhookSecretConfigured}
            patConfigured={status.legacy.patConfigured}
          />
        )}
        {confirmingDisconnect && (
          <DisconnectConfirm
            busy={disconnecting}
            onCancel={() => setConfirmingDisconnect(false)}
            onConfirm={() => void confirmDisconnect()}
          />
        )}
        {error !== undefined && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </Panel>
    );
  }

  const note = SOURCE_NOTE[status.source];
  return (
    <Panel tone={status.configured ? "neutral" : "warn"}>
      <div className="flex items-start gap-2.5">
        {status.configured ? (
          <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
        )}
        <div className="min-w-0 flex-1">
          <h2 id="github-app-heading" className="text-sm font-medium text-secondary-foreground">
            {status.configured ? "Connect a GitHub App" : "Connect GitHub"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            EraInfra registers the App for you: one click sets up the webhook, the minimum
            permissions, and the private key. No app form to fill in and no environment variables to
            copy.
          </p>
          {note !== undefined && (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">{note}</p>
          )}

          <div className="mt-3.5 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full space-y-1.5 sm:max-w-xs">
              <Label htmlFor={orgFieldId}>Organization (optional)</Label>
              <Input
                id={orgFieldId}
                value={org}
                onChange={(event) => setOrg(event.target.value)}
                placeholder="Leave empty for your personal account"
                autoComplete="off"
              />
            </div>
            <Button onClick={() => void createApp()} disabled={submitting} className="shrink-0">
              <GitPullRequest />
              {submitting ? "Redirecting…" : "Create GitHub App"}
            </Button>
          </div>

          {callbackResult?.ok === false && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{callbackResult.message}</AlertDescription>
            </Alert>
          )}
          {error !== undefined && (
            <Alert variant="destructive" className="mt-3">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </Panel>
  );
}
