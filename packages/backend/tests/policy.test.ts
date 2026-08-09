import { describe, expect, it } from "vitest";
import {
  decideRepository,
  parseRepositoryPolicy,
  summarizeRepositoryPolicy,
} from "../convex/policy.ts";

const privateRepo = false;
const publicRepo = true;

describe("parseRepositoryPolicy", () => {
  it("defaults to an empty allowlist and no public opt-in", () => {
    const policy = parseRepositoryPolicy({});
    expect(policy.allowedRepos).toEqual([]);
    expect(policy.allowPublicRepos).toBe(false);
  });

  it("splits, trims and lowercases the allowlist", () => {
    const policy = parseRepositoryPolicy({ ALLOWED_REPOS: " Acme/App , acme/tools ,, " });
    expect(policy.allowedRepos).toEqual(["acme/app", "acme/tools"]);
  });

  it("accepts the documented truthy spellings for the public opt-in", () => {
    for (const value of ["1", "true", "TRUE", " yes "]) {
      expect(parseRepositoryPolicy({ ALLOW_PUBLIC_REPOS: value }).allowPublicRepos).toBe(true);
    }
    for (const value of ["0", "false", "no", ""]) {
      expect(parseRepositoryPolicy({ ALLOW_PUBLIC_REPOS: value }).allowPublicRepos).toBe(false);
    }
  });
});

describe("decideRepository", () => {
  it("fails closed when the allowlist is unset", () => {
    const decision = decideRepository("acme/app", privateRepo, parseRepositoryPolicy({}));
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("ALLOWED_REPOS");
  });

  it("allows an exact private match", () => {
    const policy = parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app" });
    expect(decideRepository("acme/app", privateRepo, policy).allowed).toBe(true);
  });

  it("rejects a repository that is not listed", () => {
    const policy = parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app" });
    const decision = decideRepository("acme/other", privateRepo, policy);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("not in ALLOWED_REPOS");
  });

  it("matches case-insensitively, the way GitHub treats repository names", () => {
    const policy = parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app" });
    expect(decideRepository("Acme/App", privateRepo, policy).allowed).toBe(true);
  });

  it("supports owner and global wildcards", () => {
    const owner = parseRepositoryPolicy({ ALLOWED_REPOS: "acme/*" });
    expect(decideRepository("acme/anything", privateRepo, owner).allowed).toBe(true);
    expect(decideRepository("evil/anything", privateRepo, owner).allowed).toBe(false);
    // "acmecorp/x" must not match the "acme/" prefix.
    expect(decideRepository("acmecorp/x", privateRepo, owner).allowed).toBe(false);

    const global = parseRepositoryPolicy({ ALLOWED_REPOS: "*" });
    expect(decideRepository("anyone/anything", privateRepo, global).allowed).toBe(true);
  });

  it("refuses a public repository unless it is explicitly opted in", () => {
    const listed = parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app" });
    const decision = decideRepository("acme/app", publicRepo, listed);
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain("ALLOW_PUBLIC_REPOS");

    const optedIn = parseRepositoryPolicy({
      ALLOWED_REPOS: "acme/app",
      ALLOW_PUBLIC_REPOS: "true",
    });
    expect(decideRepository("acme/app", publicRepo, optedIn).allowed).toBe(true);
  });

  it("still requires the allowlist even when public repositories are opted in", () => {
    const policy = parseRepositoryPolicy({
      ALLOWED_REPOS: "acme/app",
      ALLOW_PUBLIC_REPOS: "true",
    });
    expect(decideRepository("evil/fork", publicRepo, policy).allowed).toBe(false);
  });

  it("rejects an empty repository name", () => {
    const policy = parseRepositoryPolicy({ ALLOWED_REPOS: "*" });
    expect(decideRepository("   ", privateRepo, policy).allowed).toBe(false);
  });
});

describe("summarizeRepositoryPolicy", () => {
  it("reports an unset allowlist as not configured", () => {
    const summary = summarizeRepositoryPolicy(parseRepositoryPolicy({}));
    expect(summary).toEqual({
      configured: false,
      allowedRepos: [],
      allowsAllRepos: false,
      allowPublicRepos: false,
    });
  });

  it("shows the patterns the way the matcher sees them, de-duplicated", () => {
    const summary = summarizeRepositoryPolicy(
      parseRepositoryPolicy({ ALLOWED_REPOS: " Acme/App , acme/tools , ACME/APP " }),
    );
    expect(summary.configured).toBe(true);
    expect(summary.allowedRepos).toEqual(["acme/app", "acme/tools"]);
  });

  it("flags the catch-all pattern", () => {
    expect(
      summarizeRepositoryPolicy(parseRepositoryPolicy({ ALLOWED_REPOS: "acme/*" })).allowsAllRepos,
    ).toBe(false);
    expect(
      summarizeRepositoryPolicy(parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app,*" }))
        .allowsAllRepos,
    ).toBe(true);
  });

  it("carries the public opt-in through", () => {
    const summary = summarizeRepositoryPolicy(
      parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app", ALLOW_PUBLIC_REPOS: "yes" }),
    );
    expect(summary.allowPublicRepos).toBe(true);
  });

  // A summary that says "configured" while decideRepository refuses everything
  // would be worse than no card at all.
  it("agrees with decideRepository about whether anything is allowed", () => {
    for (const value of ["", "   ", ",,"]) {
      const policy = parseRepositoryPolicy({ ALLOWED_REPOS: value });
      expect(summarizeRepositoryPolicy(policy).configured).toBe(false);
      expect(decideRepository("acme/app", privateRepo, policy).allowed).toBe(false);
    }
    const policy = parseRepositoryPolicy({ ALLOWED_REPOS: "acme/app" });
    expect(summarizeRepositoryPolicy(policy).configured).toBe(true);
    expect(decideRepository("acme/app", privateRepo, policy).allowed).toBe(true);
  });
});
