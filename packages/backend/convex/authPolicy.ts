// Pure decision logic for dashboard credentials. Kept free of Convex bindings
// so the rules can be unit tested directly and the dashboard can import the
// same constants instead of restating them, the same way bootstrapPolicy.ts is.

/**
 * A dashboard account can read every machine token, the GitHub App private key
 * and the webhook secret, and there is no second factor in front of it. Eight
 * characters — the Password provider's default floor — is not a meaningful
 * barrier for a credential of that reach.
 *
 * Enforced on account creation and password reset only. Existing accounts keep
 * working: raising the floor must not lock an operator out of their own
 * deployment, and there is no password-change flow here to send them to.
 */
export const MIN_PASSWORD_LENGTH = 12;

export const PASSWORD_REQUIREMENTS = `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

/**
 * The single answer to every failed sign-in.
 *
 * The Password provider distinguishes "no such account" from "wrong password"
 * from "too many attempts", and each of those is an oracle for whether an
 * address holds an account on this deployment. One message for all three.
 */
export const INVALID_CREDENTIALS = "Invalid email or password.";

/** Throws with {@link PASSWORD_REQUIREMENTS}; the provider expects a throw. */
export function validatePasswordRequirements(password: string) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(PASSWORD_REQUIREMENTS);
  }
}

/**
 * Whether a refusal is the password rule rather than a credential decision.
 *
 * This is the one authorize() failure worth passing through verbatim: it is
 * decided from the submitted password alone, before any account is looked up,
 * so it cannot say anything about who does or does not have an account here.
 */
export function isPasswordRequirementsError(error: unknown) {
  return error instanceof Error && error.message === PASSWORD_REQUIREMENTS;
}
