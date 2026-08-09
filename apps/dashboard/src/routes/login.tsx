import { type FormEvent, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@runner-center/backend/api";
import { createFileRoute } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({ component: LoginPage });

/**
 * `signIn` is the only flow reachable without a credential the operator was
 * given out of band. `bootstrap` trades the deployment's BOOTSTRAP_SECRET for
 * the first account; `invite` redeems a grant an existing admin handed out.
 */
type Mode = "signIn" | "bootstrap" | "invite";

const COPY: Record<Mode, { heading: string; blurb: string; submit: string }> = {
  signIn: {
    heading: "Sign in",
    blurb: "Use your dashboard credentials.",
    submit: "Sign in",
  },
  bootstrap: {
    heading: "First-time setup",
    blurb:
      "Creates the first admin account. Needs the BOOTSTRAP_SECRET set on this deployment; it is used once and never stored in your browser.",
    submit: "Create the first admin",
  },
  invite: {
    heading: "Accept an invitation",
    blurb: "Paste the single-use invitation an existing admin generated for you.",
    submit: "Create account",
  },
};

function claimFailureMessage(result: { reason: string; retryAfterMs?: number | undefined }) {
  switch (result.reason) {
    case "locked": {
      const minutes = Math.max(1, Math.ceil((result.retryAfterMs ?? 0) / 60_000));
      return `Too many failed attempts. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    }
    case "already-bootstrapped": {
      return "This instance already has an admin account. Sign in instead, or ask an admin for an invitation.";
    }
    case "unavailable": {
      return "This deployment has no bootstrap secret configured, so no account can be created. Set BOOTSTRAP_SECRET with `pnpm convex env set BOOTSTRAP_SECRET …` and reload.";
    }
    default: {
      return "That bootstrap secret was not accepted.";
    }
  }
}

function LoginPage() {
  const { signIn } = useAuthActions();
  const convex = useConvex();
  const [mode, setMode] = useState<Mode>("signIn");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      if (mode === "signIn") {
        await signIn("password", { email, password, flow: "signIn" });
        return;
      }

      // Held in a local const for the length of this call only: never in state,
      // never in the URL, never in storage.
      let signupGrant = String(form.get("invitation") ?? "");
      if (mode === "bootstrap") {
        const claimed = await convex.mutation(api.bootstrap.claim, {
          secret: String(form.get("secret") ?? ""),
        });
        if (!claimed.ok) {
          setError(claimFailureMessage(claimed));
          setSubmitting(false);
          return;
        }
        signupGrant = claimed.grantToken;
      }

      await signIn("password", { email, password, flow: "signUp", signupGrant });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
      setSubmitting(false);
    }
  }

  function changeMode(next: Mode) {
    setError(undefined);
    setSubmitting(false);
    setMode(next);
  }

  const copy = COPY[mode];

  return (
    <main className="grid min-h-screen place-items-center bg-[#0a0a0b] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <div className="grid size-10 place-items-center rounded-md border border-white/[0.1] bg-white/[0.035] font-mono text-xs font-semibold tracking-[-0.04em] text-zinc-100">
            RC
          </div>
          <span className="mt-3 text-sm font-medium text-zinc-200">Runner Center</span>
        </div>

        <section
          className="rounded-lg border border-white/[0.09] bg-[#0d0d0f] p-5"
          aria-labelledby="login-heading"
        >
          <div className="mb-5">
            <h1 id="login-heading" className="text-lg font-semibold tracking-tight text-zinc-100">
              {copy.heading}
            </h1>
            <p className="mt-1 text-sm text-[#8a8a93]">{copy.blurb}</p>
          </div>

          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            {mode === "bootstrap" && (
              <div className="overflow-hidden rounded-md border border-white/[0.12] bg-[#09090a]">
                <label htmlFor="secret" className="sr-only">
                  Bootstrap secret
                </label>
                <Input
                  id="secret"
                  name="secret"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Bootstrap secret"
                  className="h-11 rounded-none border-0 bg-transparent focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-inset"
                  required
                />
              </div>
            )}

            {mode === "invite" && (
              <div className="overflow-hidden rounded-md border border-white/[0.12] bg-[#09090a]">
                <label htmlFor="invitation" className="sr-only">
                  Invitation
                </label>
                <Input
                  id="invitation"
                  name="invitation"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Invitation"
                  className="h-11 rounded-none border-0 bg-transparent focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-inset"
                  required
                />
              </div>
            )}

            <div className="divide-y divide-white/[0.08] overflow-hidden rounded-md border border-white/[0.12] bg-[#09090a]">
              <label htmlFor="email" className="sr-only">
                Email
              </label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="Email"
                className="h-11 rounded-none border-0 bg-transparent focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-inset"
                required
              />
              <label htmlFor="password" className="sr-only">
                Password
              </label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "signIn" ? "current-password" : "new-password"}
                placeholder="Password"
                className="h-11 rounded-none border-0 bg-transparent focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-inset"
                minLength={8}
                required
              />
            </div>

            {error && (
              <p
                role="alert"
                className="rounded-md border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-xs leading-5 text-red-300"
              >
                {error}
              </p>
            )}

            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? "Please wait…" : copy.submit}
              {!submitting && <ArrowRight />}
            </Button>
          </form>

          <div className="mt-5 space-y-1 border-t border-white/[0.08] pt-4 text-center text-xs text-[#8a8a93]">
            {mode === "signIn" ? (
              <>
                <p>
                  Setting this deployment up?{" "}
                  <ModeButton onClick={() => changeMode("bootstrap")}>
                    Create the first admin
                  </ModeButton>
                </p>
                <p>
                  Been invited?{" "}
                  <ModeButton onClick={() => changeMode("invite")}>Accept an invitation</ModeButton>
                </p>
              </>
            ) : (
              <p>
                Already have an account?{" "}
                <ModeButton onClick={() => changeMode("signIn")}>Sign in</ModeButton>
              </p>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function ModeButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      className="rounded-sm font-medium text-zinc-300 outline-none transition-colors duration-150 hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-400/80"
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}
