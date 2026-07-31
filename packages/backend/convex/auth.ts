import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [Password],
  callbacks: {
    // Single-account instance: once a user exists, sign-up is closed.
    async createOrUpdateUser(ctx, args) {
      if (args.existingUserId !== null) {
        return args.existingUserId;
      }
      const anyUser = await ctx.db.query("users").first();
      if (anyUser !== null) {
        throw new Error("Sign-up is closed: this instance already has an account");
      }
      return await ctx.db.insert("users", {
        email: args.profile.email,
        emailVerificationTime: undefined,
      });
    },
  },
});
