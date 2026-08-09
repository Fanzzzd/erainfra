import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { consumeSignupGrant, SIGNUP_REFUSED } from "./bootstrap";

/**
 * `profile` runs for every flow and its return value is what reaches
 * `createOrUpdateUser` as `args.profile`. It is the only channel the Password
 * provider offers for carrying an extra sign-up parameter, so the grant token
 * rides along here. Nothing but `email` is ever written to the users table.
 */
const PasswordWithSignupGrant = Password({
  profile(params) {
    // Omitted rather than set to undefined: the provider's return type only
    // admits Convex values, and an absent grant is refused all the same.
    return {
      email: params.email as string,
      ...(typeof params.signupGrant === "string" ? { signupGrant: params.signupGrant } : {}),
    };
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [PasswordWithSignupGrant],
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
