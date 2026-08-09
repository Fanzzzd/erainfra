// Which repositories may put work on this fleet.
//
// GitHub's own guidance is that self-hosted runners should only be used with
// private repositories, because a fork of a public repository can run attacker
// controlled code on the runner host by opening a pull request. Runner Center
// therefore fails closed: nothing is accepted until an operator names the
// repositories, and a public repository additionally needs an explicit opt-in.

export type RepositoryPolicy = {
  allowedRepos: readonly string[];
  allowPublicRepos: boolean;
};

export type RepositoryDecision = { allowed: true } | { allowed: false; reason: string };

const WILDCARD = "*";

function splitList(value: string | undefined) {
  if (value === undefined) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isTruthyFlag(value: string | undefined) {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

export function parseRepositoryPolicy(env: Record<string, string | undefined>): RepositoryPolicy {
  return {
    allowedRepos: splitList(env.ALLOWED_REPOS).map((entry) => entry.toLowerCase()),
    allowPublicRepos: isTruthyFlag(env.ALLOW_PUBLIC_REPOS),
  };
}

function matchesPattern(repo: string, pattern: string) {
  if (pattern === WILDCARD) {
    return true;
  }
  if (pattern === repo) {
    return true;
  }
  // "owner/*" allows every repository under one owner.
  const ownerWildcard = pattern.endsWith(`/${WILDCARD}`);
  if (!ownerWildcard) {
    return false;
  }
  const owner = pattern.slice(0, -2);
  return owner.length > 0 && repo.startsWith(`${owner}/`);
}

export function decideRepository(
  repo: string,
  repoIsPublic: boolean,
  policy: RepositoryPolicy,
): RepositoryDecision {
  const normalized = repo.trim().toLowerCase();
  if (normalized.length === 0) {
    return { allowed: false, reason: "Webhook payload carried no repository name" };
  }
  if (policy.allowedRepos.length === 0) {
    return {
      allowed: false,
      reason:
        "ALLOWED_REPOS is not configured, so no repository may use this fleet. " +
        "Set it to a comma-separated list of owner/name entries (owner/* and * are supported).",
    };
  }
  if (!policy.allowedRepos.some((pattern) => matchesPattern(normalized, pattern))) {
    return { allowed: false, reason: `Repository ${repo} is not in ALLOWED_REPOS` };
  }
  if (repoIsPublic && !policy.allowPublicRepos) {
    return {
      allowed: false,
      reason:
        `Repository ${repo} is public and ALLOW_PUBLIC_REPOS is not enabled. ` +
        "Forks of a public repository can run untrusted code on your runner hosts.",
    };
  }
  return { allowed: true };
}
