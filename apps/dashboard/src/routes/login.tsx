import { type FormEvent, useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export const Route = createFileRoute("/login")({ component: LoginPage });

function LoginPage() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    const form = new FormData(event.currentTarget);

    try {
      await signIn("password", {
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
        flow,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Authentication failed");
      setSubmitting(false);
    }
  }

  function changeFlow() {
    setError(undefined);
    setSubmitting(false);
    setFlow((current) => (current === "signIn" ? "signUp" : "signIn"));
  }

  const isSignIn = flow === "signIn";

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
              {isSignIn ? "Sign in" : "Create account"}
            </h1>
            <p className="mt-1 text-sm text-[#8a8a93]">
              {isSignIn ? "Use your dashboard credentials." : "Create a dashboard credential."}
            </p>
          </div>

          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
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
                autoComplete={isSignIn ? "current-password" : "new-password"}
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
              {submitting ? "Please wait…" : isSignIn ? "Sign in" : "Create account"}
              {!submitting && <ArrowRight />}
            </Button>
          </form>

          <div className="mt-5 border-t border-white/[0.08] pt-4 text-center text-xs text-[#8a8a93]">
            {isSignIn ? "Need an account?" : "Already have an account?"}{" "}
            <button
              className="rounded-sm font-medium text-zinc-300 outline-none transition-colors duration-150 hover:text-emerald-300 focus-visible:ring-2 focus-visible:ring-emerald-400/80"
              type="button"
              onClick={changeFlow}
            >
              {isSignIn ? "Sign up" : "Sign in"}
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
