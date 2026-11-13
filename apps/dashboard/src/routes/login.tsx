import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "@erainfra/backend/api";
import {
  INVALID_CREDENTIALS,
  MIN_PASSWORD_LENGTH,
  PASSWORD_REQUIREMENTS,
} from "@erainfra/backend/authPolicy";
import { createFileRoute } from "@tanstack/react-router";
import { useConvex } from "convex/react";
import { ArrowRightIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { type FormEvent, useId, useState } from "react";

import { ProductWordmark } from "@/components/product-mark";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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
    "That invitation could not be used. Invitations are single-use and expire ten minutes after they are created. Ask an admin for a new one.",
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
      return "This deployment has no bootstrap secret configured, so no account can be created. Set BOOTSTRAP_SECRET with `pnpm convex env set --prod BOOTSTRAP_SECRET …` and reload.";
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
    <main className="grid min-h-screen justify-items-center bg-subtle px-4 py-12 sm:py-20">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <ProductWordmark product="infra" size="lg" />
        </div>

        <section aria-labelledby={`${fieldId}-heading-${mode}`}>
          <Card>
            <CardContent>
              <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
                <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-4">
                  <legend className="sr-only">{copy.heading}</legend>

                  <Tabs value={mode} onValueChange={changeMode} className="gap-4">
                    <TabsList className="grid w-full grid-cols-3">
                      {MODES.map((value) => (
                        <TabsTrigger key={value} value={value}>
                          {COPY[value].tab}
                        </TabsTrigger>
                      ))}
                    </TabsList>

                    {MODES.map((value) => (
                      <TabsContent key={value} value={value} className="flex flex-col gap-4">
                        <div className="flex flex-col gap-1">
                          <h1
                            id={`${fieldId}-heading-${value}`}
                            className="font-heading text-xl font-semibold tracking-title"
                          >
                            {COPY[value].heading}
                          </h1>
                          <p className="text-sm text-muted-foreground">{COPY[value].blurb}</p>
                        </div>

                        {value === "invite" && (
                          <Field>
                            <FieldLabel>Invitation</FieldLabel>
                            <Input
                              name="invitation"
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="Single-use invitation token"
                              required
                            />
                          </Field>
                        )}

                        {value === "bootstrap" && (
                          <Field>
                            <FieldLabel>Bootstrap secret</FieldLabel>
                            <Input
                              name="secret"
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              placeholder="BOOTSTRAP_SECRET"
                              required
                            />
                          </Field>
                        )}

                        <Field>
                          <FieldLabel>Email</FieldLabel>
                          <Input
                            name="email"
                            type="email"
                            autoComplete="username"
                            placeholder="you@example.com"
                            required
                          />
                        </Field>

                        <Field>
                          <FieldLabel>Password</FieldLabel>
                          <div className="relative">
                            <Input
                              id={`${fieldId}-${value}-password`}
                              name="password"
                              type={revealPassword ? "text" : "password"}
                              autoComplete={
                                value === "signIn" ? "current-password" : "new-password"
                              }
                              className="pr-9"
                              // Only on the sign-up flows: an account created before this
                              // rule existed must still be able to sign in.
                              {...(value === "signIn" ? {} : { minLength: MIN_PASSWORD_LENGTH })}
                              required
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={revealPassword ? "Hide password" : "Show password"}
                              aria-pressed={revealPassword}
                              aria-controls={`${fieldId}-${value}-password`}
                              className="absolute top-0.5 right-0.5 text-muted-foreground hover:text-foreground"
                              onClick={() => setRevealPassword((shown) => !shown)}
                            >
                              {revealPassword ? <EyeOffIcon /> : <EyeIcon />}
                            </Button>
                          </div>
                          {value !== "signIn" && (
                            <FieldDescription className="text-xs">
                              At least {MIN_PASSWORD_LENGTH} characters. This account can read every
                              machine token and GitHub credential on the deployment.
                            </FieldDescription>
                          )}
                        </Field>
                      </TabsContent>
                    ))}
                  </Tabs>
                </fieldset>

                <Button className="w-full" size="lg" type="submit" disabled={submitting}>
                  {submitting ? "Please wait…" : copy.submit}
                  {!submitting && <ArrowRightIcon data-icon="inline-end" />}
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
            </CardContent>
          </Card>
        </section>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Sign-up is closed. An account can only be created from an admin&apos;s invitation, or once
          from this deployment&apos;s bootstrap secret.
        </p>
      </div>
    </main>
  );
}
