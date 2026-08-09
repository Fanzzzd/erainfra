import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { CheckCircle2, ExternalLink, Github, TriangleAlert } from "lucide-react";
import { api } from "@convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CALLBACK_ERRORS: Record<string, string> = {
  missing_code: "GitHub did not return a registration code. Try again.",
  invalid_state:
    "The setup link expired or was already used. Start the flow again.",
  conversion_failed:
    "GitHub rejected the credential exchange. Check the Convex logs and try again.",
};

function convexSiteUrl() {
  return String(import.meta.env.VITE_CONVEX_URL).replace(
    /\.convex\.cloud\/?$/,
    ".convex.site",
  );
}

// The Manifest callback redirects here with a result; read it once, then strip
// it so a refresh does not replay the banner.
function useCallbackResult() {
  const [result, setResult] = useState<
    { ok: true } | { ok: false; message: string } | undefined
  >();

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
              CALLBACK_ERRORS[params.get("reason") ?? ""] ??
              "GitHub App setup did not complete.",
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
      setError(
        caught instanceof Error ? caught.message : "Could not start GitHub setup",
      );
      setSubmitting(false);
    }
  }

  if (status.source === "manifest") {
    return (
      <section
        className="rounded-lg border border-white/[0.08] bg-[#0d0d0f] px-4 py-3.5"
        aria-labelledby="github-app-heading"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
            <div>
              <h2 id="github-app-heading" className="text-sm font-medium text-zinc-200">
                GitHub App connected
              </h2>
              <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
                {status.name} (app ID {status.appId}). Webhook and JIT runner
                credentials are managed for you.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={status.installUrl} target="_blank" rel="noreferrer">
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
      </section>
    );
  }

  if (status.source === "env" || status.source === "pat") {
    return (
      <section className="rounded-lg border border-white/[0.08] bg-[#0d0d0f] px-4 py-3.5">
        <h2 className="text-sm font-medium text-zinc-200">
          GitHub credentials from environment variables
        </h2>
        <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
          {status.source === "env"
            ? "A hand-registered GitHub App is configured through GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY."
            : "Only the legacy GITHUB_PAT is configured. App installations are not available on this path."}{" "}
          Credentials stored here take priority over anything created below.
        </p>
      </section>
    );
  }

  return (
    <section
      className="rounded-lg border border-amber-400/[0.25] bg-amber-400/[0.04] px-4 py-4"
      aria-labelledby="github-app-heading"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1">
          <h2 id="github-app-heading" className="text-sm font-medium text-zinc-200">
            Connect GitHub
          </h2>
          <p className="mt-1 text-xs leading-5 text-[#8a8a93]">
            Runner Center creates the GitHub App for you: one click registers the
            webhook, permissions, and private key. No manual app form, no
            environment variables to copy.
          </p>

          <div className="mt-3.5 flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="w-full sm:max-w-xs">
              <Label htmlFor="github-org" className="text-xs text-[#8a8a93]">
                Organization (optional)
              </Label>
              <Input
                id="github-org"
                value={org}
                onChange={(event) => setOrg(event.target.value)}
                placeholder="Leave empty for your personal account"
                className="mt-1.5"
                autoComplete="off"
              />
            </div>
            <Button
              onClick={() => void createApp()}
              disabled={submitting}
              className="shrink-0"
            >
              <Github />
              {submitting ? "Redirecting…" : "Create GitHub App"}
            </Button>
          </div>

          {callbackResult?.ok === false && (
            <p className="mt-3 text-xs text-red-300">{callbackResult.message}</p>
          )}
          {error !== undefined && (
            <p className="mt-3 text-xs text-red-300">{error}</p>
          )}
        </div>
      </div>
    </section>
  );
}
