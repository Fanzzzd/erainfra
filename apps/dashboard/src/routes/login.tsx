import { type FormEvent, useId, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@runner-center/backend/api";
import {
  INVALID_CREDENTIALS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS,
} from "@runner-center/backend/authPolicy";
import { createFileRoute } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export const Route = createFileRoute("/login")({ component: LoginPage });

/**
 * `signIn` is the only flow reachable without a credential the operator was
 * given out of band. `bootstrap` trades the deployment's BOOTSTRAP_SECRET for
 * the first account; `invite` redeems a grant an existing admin handed out.
 */
type Mode = "signIn" | "invite" | "bootstrap";

const MODES: Mode[] = ["signIn", "invite", "bootstrap"];

const COPY: Record<Mode, { tab: string; heading: string; blurb: string; submit: string }> = {
  signIn: {
    tab: "Sign in",
    heading: "Sign in",
    blurb: "Use your dashboard credentials.",
    submit: "Sign in",
  },
  invite: {
    tab: "Invitation",
    heading: "Accept an invitation",
    blurb: "Paste the single-use invitation an existing admin generated for you.",
    submit: "Create account",
  },
  bootstrap: {
    tab: "First run",
    heading: "First-time setup",
    blurb:
      "Creates the first admin account. Needs the BOOTSTRAP_SECRET set on this deployment; it is used once and never stored in your browser.",
    submit: "Create the first admin",
  },
};

/**
 * The refusal an operator sees. Deliberately not the server's text: the server
 * already answers uniformly, and echoing whatever it returned would put that
 * guarantee at the mercy of a future change on the other side of the wire.
 */
const FAILURE_COPY: Record<Mode, string> = {
  signIn: INVALID_CREDENTIALS,
  invite:
    "That invitation could not be used. Invitations are single-use and expire ten minutes after they are created — ask an admin for a new one.",
  bootstrap: "This deployment would not create an account with that secret.",
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
  const fieldId = useId();
  const [mode, setMode] = useState<Mode>("signIn");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [revealPassword, setRevealPassword] = useState(false);
  const isSignUp = mode !== "signIn";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    // Mirrors validatePasswordRequirements on the provider, so the rule is
    // stated before a round trip rather than only after one.
    if (isSignUp && password.length < MIN_PASSWORD_LENGTH) {
      setError(PASSWORD_REQUIREMENTS);
      return;
    }

    setSubmitting(true);
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
      // The password rule is the one refusal that names its own cause; every
      // other failure gets this mode's uniform copy.
      const message = caught instanceof Error ? caught.message : "";
      setError(
        message.includes(PASSWORD_REQUIREMENTS) ? PASSWORD_REQUIREMENTS : FAILURE_COPY[mode],
      );
      setSubmitting(false);
    }
  }

  function changeMode(next: string) {
    setError(undefined);
    setSubmitting(false);
    setRevealPassword(false);
    setMode(next as Mode);
  }

  const copy = COPY[mode];

  return (
    <main className="grid min-h-screen justify-items-center bg-background px-4 py-12 sm:py-20">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <div className="grid size-10 place-items-center rounded-md border border-border bg-secondary font-mono text-xs font-semibold tracking-[-0.04em] text-foreground">
            RC
          </div>
          <span className="mt-3 text-sm font-medium text-secondary-foreground">Runner Center</span>
        </div>

        <section
          className="rounded-lg border border-border bg-card p-5"
          aria-labelledby={`${fieldId}-heading-${mode}`}
        >
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <fieldset disabled={submitting} className="space-y-4">
              <legend className="sr-only">{copy.heading}</legend>

              <Tabs value={mode} onValueChange={changeMode}>
                <TabsList className="grid w-full grid-cols-3">
                  {MODES.map((value) => (
                    <TabsTrigger key={value} value={value}>
                      {COPY[value].tab}
                    </TabsTrigger>
                  ))}
                </TabsList>

                {MODES.map((value) => (
                  <TabsContent key={value} value={value} className="space-y-4">
                    <div>
                      <h1
                        id={`${fieldId}-heading-${value}`}
                        className="text-lg font-semibold tracking-tight text-foreground"
                      >
                        {COPY[value].heading}
                      </h1>
                      <p className="mt-1 text-sm leading-5 text-muted-foreground">
                        {COPY[value].blurb}
                      </p>
                    </div>

                    {value === "invite" && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-invitation`}>Invitation</Label>
                        <Input
                          id={`${fieldId}-invitation`}
                          name="invitation"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="Single-use invitation token"
                          required
                        />
                      </div>
                    )}

                    {value === "bootstrap" && (
                      <div className="space-y-1.5">
                        <Label htmlFor={`${fieldId}-secret`}>Bootstrap secret</Label>
                        <Input
                          id={`${fieldId}-secret`}
                          name="secret"
                          type="password"
                          autoComplete="off"
                          spellCheck={false}
                          placeholder="BOOTSTRAP_SECRET"
                          required
                        />
                      </div>
                    )}
                  </TabsContent>
                ))}
              </Tabs>

              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-email`}>Email</Label>
                <Input
                  id={`${fieldId}-email`}
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-password`}>Password</Label>
                <div className="relative">
                  <Input
                    id={`${fieldId}-password`}
                    name="password"
                    type={revealPassword ? "text" : "password"}
                    autoComplete={isSignUp ? "new-password" : "current-password"}
                    className="pr-10"
                    // Only on the sign-up flows: an account created before this
                    // rule existed must still be able to sign in.
                    {...(isSignUp ? { minLength: MIN_PASSWORD_LENGTH } : {})}
                    required
                  />
                  <button
                    type="button"
                    aria-label={revealPassword ? "Hide password" : "Show password"}
                    aria-pressed={revealPassword}
                    aria-controls={`${fieldId}-password`}
                    className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
                    onClick={() => setRevealPassword((shown) => !shown)}
                  >
                    {revealPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                  </button>
                </div>
                {isSignUp && (
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    At least {MIN_PASSWORD_LENGTH} characters. This account can read every machine
                    token and GitHub credential on the deployment.
                  </p>
                )}
              </div>
            </fieldset>

            <Button className="w-full" type="submit" disabled={submitting}>
              {submitting ? "Please wait…" : copy.submit}
              {!submitting && <ArrowRight />}
            </Button>

            {/* Below the button, on a page laid out from the top: a refusal
                grows the card downwards and no field or control the operator is
                already pointing at moves. Refusals vary from one line to five,
                so reserving a fixed height would either still shift or leave a
                permanent gap. */}
            <div aria-live="polite">
              {error !== undefined && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          </form>
        </section>

        <p className="mt-4 text-center text-xs leading-5 text-subtle-foreground">
          Sign-up is closed. An account can only be created from an admin&apos;s invitation, or once
          from this deployment&apos;s bootstrap secret.
        </p>
      </div>
    </main>
  );
}
