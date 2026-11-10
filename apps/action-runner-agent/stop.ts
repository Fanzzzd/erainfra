/**
 * How the Worker stops (#284). The first stop signal drains: no new claims,
 * running work finishes and reports, then the Worker exits. A second signal
 * cancels the running work instead of waiting. Buildkite and GitLab Runner
 * stop the same way, so an upgrade or a config restart never ends a job.
 *
 * The systemd unit pairs with this: KillMode=mixed sends the stop signal to
 * the Agent alone, so its per-Attempt children are not signalled behind its
 * back, and TimeoutStopSec=infinity lets the drain take as long as the job.
 */
export type StopSequence = {
  /** Number of claims or Attempts still in flight, including their reports. */
  activeWork: () => number;
  /** Resolves once activeWork() reaches zero. */
  waitForIdle: () => Promise<void>;
  /** Stops claiming new work. Runs once, on the first signal. */
  stopClaiming: () => void;
  /** Signals every running executor. Runs at most once, on the second signal. */
  cancelWork: () => void;
  /** Releases connections and timers after the work is gone. Runs once. */
  finish: () => Promise<void>;
  log?: (message: string) => void;
};

export function createStopHandler(sequence: StopSequence) {
  const log = sequence.log ?? console.log;
  let stopping: Promise<void> | undefined;
  let cancelled = false;

  return (signal: string): Promise<void> => {
    if (stopping !== undefined) {
      if (!cancelled) {
        cancelled = true;
        log(`Received ${signal} again; cancelling ${sequence.activeWork()} running work item(s)`);
        sequence.cancelWork();
      }
      return stopping;
    }
    stopping = (async () => {
      sequence.stopClaiming();
      const active = sequence.activeWork();
      if (active > 0) {
        log(
          `Received ${signal}; claiming no new work and waiting for ${active} running work ` +
            `item(s) to finish. Send ${signal} again to cancel them.`,
        );
        await sequence.waitForIdle();
      } else {
        log(`Received ${signal}; stopping Worker`);
      }
      await sequence.finish();
    })();
    return stopping;
  };
}

/** Counts in-flight work and wakes waiters when the count returns to zero. */
export function createWorkCounter() {
  let active = 0;
  let waiters: (() => void)[] = [];
  return {
    get active() {
      return active;
    },
    start() {
      active += 1;
    },
    finish() {
      active = Math.max(0, active - 1);
      if (active > 0) return;
      const ready = waiters;
      waiters = [];
      for (const wake of ready) wake();
    },
    idle(): Promise<void> {
      if (active === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}
