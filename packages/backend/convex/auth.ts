import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import {
  INVALID_CREDENTIALS,
  isPasswordRequirementsError,
  validatePasswordRequirements,
} from "./authPolicy";
import { consumeSignupGrant, SIGNUP_REFUSED } from "./bootstrap";

/**
 * `profile` runs for every flow and its return value is what reaches
 * `createOrUpdateUser` as `args.profile`. It is the only channel the Password
 * provider offers for carrying an extra sign-up parameter, so the grant token
 * rides along here. Nothing but `email` is ever written to the users table.
 */
const passwordProvider = Password({
  profile(params) {
    // Omitted rather than set to undefined: the provider's return type only
    // admits Convex values, and an absent grant is refused all the same.
    return {
      email: params.email as string,
      ...(typeof params.signupGrant === "string" ? { signupGrant: params.signupGrant } : {}),
    };
  },
  // Runs before any account lookup, on "signUp" and "reset-verification".
  validatePasswordRequirements,
});

type Authorize = (params: Record<string, unknown>, ctx: unknown) => Promise<unknown>;

/**
 * The one message a caller gets for a given flow, whatever actually went wrong.
 *
 * `retrieveAccount` throws `InvalidAccountId` when no account holds the address
 * and `InvalidSecret` when one does but the password is wrong, and
 * `createAccount` throws `Account <email> already exists` — so both the sign-in
 * *and* the sign-up paths would otherwise answer "does this address have an
 * account here?" for an unauthenticated caller. The sign-up path is the worse
 * of the two: it needs no grant to reach that answer.
 *
 * The original is logged, so an operator can still diagnose from the Convex
 * logs what the caller is deliberately not told.
 */
function uniformFailure(flow: unknown, error: unknown) {
  if (isPasswordRequirementsError(error)) return error;
  console.error("auth: refused a credential attempt", { flow, error });
  return new Error(flow === "signUp" ? SIGNUP_REFUSED : INVALID_CREDENTIALS);
}

/**
 * Wraps the provider's `authorize` so every refusal leaves through
 * {@link uniformFailure}.
 *
 * `ConvexCredentials` keeps the real implementation on the internal `options`
 * object and the framework merges it over the provider at materialisation
 * time, so this replaces that one function and leaves hashing, the flows and
 * the callbacks untouched. If that shape ever changes the throw below fails the
 * push rather than quietly shipping a provider that leaks again.
 */
function withUniformFailures<Provider>(provider: Provider): Provider {
  const options = (provider as { options?: Record<string, unknown> }).options;
  if (options === undefined || typeof options.authorize !== "function") {
    throw new Error(
      "Password provider no longer exposes `options.authorize`; sign-in failures would leak whether an account exists",
    );
  }

  const authorize = options.authorize as Authorize;
  return {
    ...provider,
    options: {
      ...options,
      authorize: async (params: Record<string, unknown>, ctx: unknown) => {
        try {
          return await authorize(params, ctx);
        } catch (error) {
          throw uniformFailure(params.flow, error);
        }
      },
    },
  } as Provider;
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [withUniformFailures(passwordProvider)],
  callbacks: {
    /**
     * Sign-up is closed. Reached only when a *new* account is being created --
     * signing in to an existing account goes through `retrieveAccount` and
     * never lands here -- so existing users and their logins are untouched.
     *
     * Creating an account requires a live single-use grant: either the
     * bootstrap grant minted from BOOTSTRAP_SECRET while the instance had no
     * users, or an invite issued by an authenticated admin. Before this,
     * whoever reached the deployment first could claim the sole admin account,
     * and with it the GitHub App private key, the webhook secret and every
     * machine token.
     */
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId !== null) {
        return args.existingUserId;
      }

      const profile = args.profile as { email?: unknown; signupGrant?: unknown };
      await consumeSignupGrant(ctx, profile.signupGrant);

      if (typeof profile.email !== "string" || profile.email.length === 0) {
        throw new Error(SIGNUP_REFUSED);
      }

      return await ctx.db.insert("users", {
        email: profile.email,
        emailVerificationTime: undefined,
      });
    },
  },
});
