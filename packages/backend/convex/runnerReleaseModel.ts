// actions/runner releases and how far a Profile's image is from GitHub's cutoff. Pure functions
// only, so the rule is tested without a database or the network; runnerReleases.ts stores the list
// and github.ts fetches it.
//
// The controller registers every scale set with automatic updates off (DisableUpdate in
// apps/controller/internal/githubscale), so a Runner only ever runs the version its image pins.
// GitHub's rule for such a runner: "you must update the runner
// within 30 days of a new version being released", after which the service stops queueing jobs to
// it and the runner exits with "Runner version vX is deprecated and cannot receive messages"
// (docs.github.com/en/actions/reference/runners/self-hosted-runners). The clock for a version
// starts when the release after it, its successor, is published. Counting from the newest release
// instead would warn too late whenever more than one release has shipped since the image was
// built: from 2.336.0, a 2.337.0 on day 0 and a 2.338.0 on day 20 put the cutoff on day 30, not 50.
//
// The release list comes from GitHub (github.ts refreshRunnerReleases, hourly, refetching at most
// every six hours) and the image's version from the Worker's readiness report, or from the image
// tag for the Docker executor. The alert that reads both lives in alertRules.ts.

import { v, type Infer } from "convex/values";

const DAY_MS = 24 * 60 * 60_000;

/** How long after its successor's release GitHub keeps serving a runner version. */
export const RUNNER_RELEASE_GRACE_MS = 30 * DAY_MS;
/** When the alert starts: five days before the cutoff, time to rebuild the image and roll it. */
export const RUNNER_RELEASE_WARN_AFTER_MS = 25 * DAY_MS;
/** The list is refetched once it is this old. Five days of headroom absorb a day of failures. */
export const RUNNER_RELEASE_REFRESH_MS = 6 * 60 * 60_000;
/** The page size the refresh asks for, and the most releases stored. */
export const RUNNER_RELEASE_PAGE = 100;

const VERSION_PATTERN = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export const runnerReleaseValidator = v.object({ version: v.string(), publishedAt: v.number() });
export type RunnerRelease = Infer<typeof runnerReleaseValidator>;

/** A runner version as x.y.z, or undefined for anything else. */
export function runnerVersionOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VERSION_PATTERN.test(trimmed) ? trimmed : undefined;
}

export function compareRunnerVersions(left: string, right: string) {
  const a = VERSION_PATTERN.exec(left);
  const b = VERSION_PATTERN.exec(right);
  if (a === null || b === null)
    throw new Error(`Not a runner version: ${a === null ? left : right}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The releases in a `GET /repos/actions/runner/releases` page, with the rules scripts/pinbump
 * applies to `releases/latest`: drafts and pre-releases are skipped, and so is any tag that is not
 * vX.Y.Z or carries no publication date. Oldest version first.
 */
export function parseRunnerReleases(payload: unknown): RunnerRelease[] {
  if (!Array.isArray(payload)) throw new Error("GitHub's release list is not an array");
  const byVersion = new Map<string, number>();
  for (const entry of payload.slice(0, RUNNER_RELEASE_PAGE) as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const release = entry as Record<string, unknown>;
    if (release.draft === true || release.prerelease === true) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const version = runnerVersionOf(tag.startsWith("v") ? tag.slice(1) : tag);
    const publishedAt =
      typeof release.published_at === "string" ? Date.parse(release.published_at) : Number.NaN;
    if (version === undefined || !Number.isFinite(publishedAt)) continue;
    byVersion.set(version, publishedAt);
  }
  return [...byVersion]
    .map(([version, publishedAt]) => ({ version, publishedAt }))
    .toSorted((left, right) => compareRunnerVersions(left.version, right.version));
}

/**
 * Where a runner version stands against GitHub's cutoff.
 *
 * - `current`: no release newer than it is known.
 * - `supported`: a newer release exists, published less than 25 days ago.
 * - `expiring`: 25 to 30 days since its successor; jobs still run, but not for long.
 * - `expired`: past 30 days; GitHub refuses the runner. Also a version older than every release on
 *   the list: its successor is older than the list reaches, so its cutoff passed long ago.
 */
export type RunnerReleaseStanding =
  | { state: "current"; version: string }
  | {
      state: "supported" | "expiring" | "expired";
      version: string;
      successor: RunnerRelease;
      newest: RunnerRelease;
      deadline: number;
      /** True when the successor is the oldest release listed, so the true one may be older. */
      successorBeforeList: boolean;
    };

export function runnerReleaseStanding(
  version: string,
  releases: readonly RunnerRelease[],
  now: number,
): RunnerReleaseStanding | undefined {
  if (runnerVersionOf(version) === undefined) return undefined;
  const newer = releases
    .filter((release) => compareRunnerVersions(release.version, version) > 0)
    .toSorted((left, right) => compareRunnerVersions(left.version, right.version));
  const successor = newer[0];
  const newest = newer.at(-1);
  if (successor === undefined || newest === undefined) return { state: "current", version };
  const successorBeforeList = releases.every(
    (release) => compareRunnerVersions(release.version, version) > 0,
  );
  const deadline = successor.publishedAt + RUNNER_RELEASE_GRACE_MS;
  const state = successorBeforeList
    ? "expired"
    : now >= deadline
      ? "expired"
      : now >= successor.publishedAt + RUNNER_RELEASE_WARN_AFTER_MS
        ? "expiring"
        : "supported";
  return { state, version, successor, newest, deadline, successorBeforeList };
}

/** The image tag's version for an `actions/actions-runner` image, as the Docker executor pins. */
export function runnerVersionFromImageRelease(imageRelease: string): string | undefined {
  const match = /(?:^|\/)actions-runner:(\d{1,6}\.\d{1,6}\.\d{1,6})(?:@|$)/.exec(imageRelease);
  return match?.[1];
}
