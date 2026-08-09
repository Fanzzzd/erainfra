import { type ReactNode, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CircleCheck, ExternalLink, Github, KeyRound, TriangleAlert } from "lucide-react";
import { api } from "@runner-center/backend/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { convexSiteUrl } from "@/lib/convex-site";

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
      className={
        tone === "warn"
          ? "rounded-lg border border-amber-400/[0.25] bg-amber-400/[0.04] px-4 py-4"
          : "rounded-lg border border-white/[0.08] bg-[#0d0d0f] px-4 py-3.5"
      }
      aria-labelledby="github-app-heading"
    >
      {children}
    </section>
  );
}

export function GithubAppSetup() {
  const status = useQuery(api.githubApp.status);
  const beginSetup = useMutation(api.githubApp.beginSetup);
  const disconnect = useMutation(api.githubApp.disconnect);
  const callbackResult = useCallbackResult();
  const [org, setOrg] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  if (status === undefined) return null;

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
            <CircleCheck className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            <div className="min-w-0">
              <h2 id="github-app-heading" className="text-sm font-medium text-zinc-200">
                GitHub App connected
              </h2>
              <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
                {app.name} · app ID {app.appId} · client ID{" "}
                <code className="font-mono text-[#a1a1aa]">{app.clientId}</code>
              </p>
              <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
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
              onClick={() => void disconnect({})}
              title="Forget these credentials. The app itself stays on GitHub."
            >
              Disconnect
            </Button>
          </div>
        </div>
        {callbackResult?.ok === true && (
          <p className="mt-3 border-t border-white/[0.08] pt-3 text-xs text-emerald-300">
            App created. Install it on the repositories Runner Center should serve.
          </p>
        )}
      </Panel>
    );
  }

  const note = SOURCE_NOTE[status.source];
  return (
    <Panel tone={status.configured ? "neutral" : "warn"}>
      <div className="flex items-start gap-2.5">
        {status.configured ? (
          <KeyRound className="mt-0.5 size-4 shrink-0 text-[#8a8a93]" />
        ) : (
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
        )}
        <div className="min-w-0 flex-1">
          <h2 id="github-app-heading" className="text-sm font-medium text-zinc-200">
            {status.configured ? "Connect a GitHub App" : "Connect GitHub"}
          </h2>
          <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
            Runner Center registers the App for you: one click sets up the webhook, the minimum
            permissions, and the private key. No app form to fill in and no environment variables to
            copy.
          </p>
          {note !== undefined && <p className="mt-2 text-xs leading-5 text-[#8a8a93]">{note}</p>}

          <div className="mt-3.5 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:max-w-xs">
              <label htmlFor="github-org" className="block text-xs text-[#8a8a93]">
                Organization (optional)
              </label>
              <Input
                id="github-org"
                value={org}
                onChange={(event) => setOrg(event.target.value)}
                placeholder="Leave empty for your personal account"
                className="mt-1.5"
                autoComplete="off"
              />
            </div>
            <Button onClick={() => void createApp()} disabled={submitting} className="shrink-0">
              <Github />
              {submitting ? "Redirecting…" : "Create GitHub App"}
            </Button>
          </div>

          {callbackResult?.ok === false && (
            <p className="mt-3 text-xs text-red-300">{callbackResult.message}</p>
          )}
          {error !== undefined && <p className="mt-3 text-xs text-red-300">{error}</p>}
        </div>
      </div>
    </Panel>
  );
}
