import { vi } from "vitest";

/**
 * Run fixture setup on a fake clock set `lead` ms before `at`, then leave the clock at `at`.
 *
 * convex-test (0.0.63 and later) gives each transaction a pinned time at or after the
 * previous commit, like the real backend. With a frozen fake clock, two or more setup
 * commits at `at` push every later transaction to `at + 1` ms. Seeding earlier lets the
 * code under test run at exactly `at`.
 */
export async function setUpBefore<T>(
  at: number,
  setup: () => Promise<T>,
  lead = 60_000,
): Promise<T> {
  vi.setSystemTime(at - lead);
  try {
    return await setup();
  } finally {
    vi.setSystemTime(at);
  }
}
