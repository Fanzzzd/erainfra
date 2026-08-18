import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CoreAllocator,
  CoreExhaustedError,
  CPUSET_EXHAUSTED_EXIT,
  formatCpuset,
  parseCpuset,
  reconcileDockerReservations,
  withCores,
  type DockerRunner,
} from "../cpuset.ts";

/** Every core any live reservation holds, and a proof none of them overlap. */
function heldCores(allocator: CoreAllocator) {
  const reservations = allocator.reservations();
  const union = new Set(reservations.flatMap((reservation) => reservation.cores));
  const total = reservations.reduce((sum, reservation) => sum + reservation.cores.length, 0);
  assert.equal(union.size, total, "two live reservations share a core");
  assert.equal(allocator.freeCores, allocator.totalCores - union.size);
  return union;
}

describe("cpuset formatting", () => {
  it("writes cores the way Docker, cgroups and taskset read them", () => {
    assert.equal(formatCpuset([0, 1, 2, 3]), "0-3");
    assert.equal(formatCpuset([3, 1, 0, 2]), "0-3");
    assert.equal(formatCpuset([5]), "5");
    assert.equal(formatCpuset([0, 1, 4, 5]), "0-1,4-5");
    assert.equal(formatCpuset([0, 2, 4]), "0,2,4");
    assert.equal(formatCpuset([]), "");
  });

  it("round-trips every shape it produces", () => {
    for (const cores of [[0], [0, 1, 2, 3], [0, 1, 4, 5], [2, 4, 6], [7, 8, 9, 15]]) {
      assert.deepEqual(parseCpuset(formatCpuset(cores)), cores);
    }
  });

  it("refuses anything it does not fully understand rather than guessing", () => {
    for (const spec of ["", "  ", "a", "0-", "-1", "1-0", "0,,1", "0-3,x", "0.5", "0 1"]) {
      assert.equal(parseCpuset(spec), undefined, spec);
    }
  });
});

describe("CoreAllocator", () => {
  it("gives an Attempt exactly as many cores as its Profile's vCPUs", () => {
    const allocator = new CoreAllocator(16);
    const reservation = allocator.reserve("attempt:a", 4);
    assert.ok(reservation);
    assert.equal(reservation.cores.length, 4);
    assert.equal(parseCpuset(reservation.spec)?.length, 4);
    assert.equal(reservation.spec, "0-3");
    assert.equal(allocator.freeCores, 12);
  });

  // Pinning every Attempt to 0-7 is what makes a cpuset worse than the quota it
  // replaces: the same eight cores carry every job on the Worker.
  it("never hands the same core to two concurrent Attempts", () => {
    const allocator = new CoreAllocator(8);
    const first = allocator.reserve("attempt:a", 4);
    const second = allocator.reserve("attempt:b", 4);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.spec, "0-3");
    assert.equal(second.spec, "4-7");
    heldCores(allocator);
  });

  it("refuses rather than over-subscribing when the Worker is full", () => {
    const allocator = new CoreAllocator(8);
    assert.ok(allocator.reserve("attempt:a", 6));
    assert.equal(allocator.reserve("attempt:b", 4), undefined);
    // The refusal must not consume the cores it could not gather.
    assert.equal(allocator.freeCores, 2);
    assert.equal(allocator.has("attempt:b"), false);
    assert.ok(allocator.reserve("attempt:c", 2));
  });

  it("refuses a Profile wider than the whole Worker", () => {
    const allocator = new CoreAllocator(4);
    assert.equal(allocator.reserve("attempt:a", 8), undefined);
    assert.equal(allocator.freeCores, 4);
  });

  it("returns exactly the cores a release gave back", () => {
    const allocator = new CoreAllocator(8);
    allocator.reserve("attempt:a", 2);
    const second = allocator.reserve("attempt:b", 4);
    assert.equal(second?.spec, "2-5");
    assert.equal(allocator.release("attempt:b"), true);
    assert.equal(allocator.release("attempt:b"), false);
    assert.equal(allocator.freeCores, 6);
    assert.equal(allocator.reserve("attempt:c", 4)?.spec, "2-5");
  });

  it("fills a fragmented Worker instead of failing on the gap", () => {
    const allocator = new CoreAllocator(8);
    allocator.reserve("attempt:a", 2);
    allocator.reserve("attempt:b", 2);
    allocator.reserve("attempt:c", 2);
    allocator.release("attempt:b");
    assert.equal(allocator.reserve("attempt:d", 4)?.spec, "2-3,6-7");
  });

  it("treats a nonsensical width as a bug rather than a refusal", () => {
    const allocator = new CoreAllocator(8);
    assert.throws(() => allocator.reserve("attempt:a", 0));
    assert.throws(() => allocator.reserve("attempt:a", 1.5));
    allocator.reserve("attempt:a", 1);
    assert.throws(() => allocator.reserve("attempt:a", 1), /already holds/);
  });
});

describe("withCores", () => {
  it("releases the range when the job finishes", async () => {
    const allocator = new CoreAllocator(8);
    const spec = await withCores(allocator, { key: "attempt:a", vcpus: 4 }, async (reservation) => {
      assert.equal(allocator.freeCores, 4);
      return reservation?.spec;
    });
    assert.equal(spec, "0-3");
    assert.equal(allocator.freeCores, 8);
  });

  // Failure, cancellation, timeout and an Agent shutdown all reach this
  // function as a rejected body: the child was killed and its promise settled.
  it("releases the range on every failing teardown path", async () => {
    const allocator = new CoreAllocator(8);
    for (const failure of [
      new Error("the executor did not spawn"),
      new Error("the control plane cancelled the Attempt while it was starting"),
      new Error("the job exceeded RC_JOB_TIMEOUT_S"),
      new Error("Received SIGTERM; stopping Worker"),
    ]) {
      await assert.rejects(
        withCores(allocator, { key: "attempt:a", vcpus: 4 }, async () => {
          throw failure;
        }),
        /executor|cancelled|RC_JOB_TIMEOUT_S|SIGTERM/,
      );
      assert.equal(allocator.freeCores, 8, failure.message);
      assert.equal(allocator.has("attempt:a"), false);
    }
  });

  it("refuses fail-closed, with the numbers, when the Worker has no cores left", async () => {
    const allocator = new CoreAllocator(4);
    allocator.reserve("attempt:a", 3);
    let started = false;
    await assert.rejects(
      withCores(allocator, { key: "attempt:b", vcpus: 2 }, async () => {
        started = true;
        return 0;
      }),
      (error: unknown) => {
        assert.ok(error instanceof CoreExhaustedError);
        assert.match(error.message, /needs 2 of this Worker's 4 CPUs but only 1 are free/);
        return true;
      },
    );
    assert.equal(started, false, "the job ran anyway, over-subscribed");
    assert.equal(allocator.freeCores, 1);
    assert.equal(CPUSET_EXHAUSTED_EXIT, 75);
  });

  it("runs work that takes none of this Worker's cores without reserving", async () => {
    const allocator = new CoreAllocator(4);
    const reservation = await withCores(allocator, { key: "attempt:mac" }, async (held) => held);
    assert.equal(reservation, undefined);
    assert.equal(allocator.freeCores, 4);
  });

  it("keeps ranges disjoint across interleaved concurrent work", async () => {
    const allocator = new CoreAllocator(16);
    // Deterministic: a seeded step, not Math.random, so a failure reproduces.
    let seed = 7;
    const nextDelay = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 4;
    };
    const widths = [1, 2, 4, 8, 2, 1, 4, 2, 1, 8, 2, 4];
    const refused: number[] = [];

    await Promise.all(
      widths.map(async (vcpus, index) => {
        for (let round = 0; round < 6; round += 1) {
          await new Promise((resolve) => setTimeout(resolve, nextDelay()));
          try {
            await withCores(allocator, { key: `attempt:${index}`, vcpus }, async () => {
              heldCores(allocator);
              await new Promise((resolve) => setTimeout(resolve, nextDelay()));
              heldCores(allocator);
            });
          } catch (error) {
            assert.ok(error instanceof CoreExhaustedError);
            refused.push(vcpus);
          }
        }
      }),
    );

    // Nothing may be left holding cores once every job has finished; a leak here
    // is a Worker that silently loses capacity until it is restarted.
    assert.equal(allocator.freeCores, 16);
    assert.deepEqual(allocator.reservations(), []);
    assert.ok(refused.length > 0, "the fixture never exercised the exhaustion path");
  });
});

/** A `docker ps` / `docker inspect` pair over a fixed set of containers. */
function fakeDocker(containers: { name: string; cpuset: string }[]): DockerRunner {
  return async (args) => {
    if (args[0] === "ps") {
      return { exitCode: 0, stdout: containers.map((c) => c.name).join("\n") };
    }
    const wanted = new Set(args.slice(3));
    return {
      exitCode: 0,
      stdout: containers
        .filter((c) => wanted.has(c.name))
        .map((c) => `/${c.name}\t${c.cpuset}`)
        .join("\n"),
    };
  };
}

describe("reconcileDockerReservations", () => {
  it("adopts the cores a container survived the Agent holding", async () => {
    const allocator = new CoreAllocator(16);
    const result = await reconcileDockerReservations(allocator, {
      runDocker: fakeDocker([
        { name: "rc-runner-a", cpuset: "0-3" },
        { name: "rc-runner-b", cpuset: "8-9" },
      ]),
    });

    assert.deepEqual(result.adopted, ["rc-runner-a", "rc-runner-b"]);
    assert.deepEqual(result.released, []);
    assert.equal(allocator.freeCores, 10);
    // The next Attempt must be given cores the survivors are not on.
    assert.equal(allocator.reserve("attempt:new", 4)?.spec, "4-7");
    heldCores(allocator);
  });

  it("gives the cores back once the orphan exits", async () => {
    const allocator = new CoreAllocator(8);
    const runDocker = fakeDocker([{ name: "rc-runner-a", cpuset: "0-3" }]);
    await reconcileDockerReservations(allocator, { runDocker });
    assert.equal(allocator.freeCores, 4);

    const after = await reconcileDockerReservations(allocator, { runDocker: fakeDocker([]) });
    assert.deepEqual(after.released, ["rc-runner-a"]);
    assert.equal(allocator.freeCores, 8);
    assert.deepEqual(allocator.reservations(), []);
  });

  it("does not double-count a container this Agent started", async () => {
    const allocator = new CoreAllocator(8);
    allocator.reserve("attempt:a", 4, "rc-runner-a");
    const result = await reconcileDockerReservations(allocator, {
      runDocker: fakeDocker([{ name: "rc-runner-a", cpuset: "0-3" }]),
    });

    assert.deepEqual(result.adopted, []);
    assert.equal(allocator.freeCores, 4);
    // ...and its release still belongs to the Attempt that made it.
    assert.equal(allocator.release("attempt:a"), true);
    assert.equal(allocator.freeCores, 8);
  });

  it("changes nothing when the daemon cannot be read", async () => {
    const allocator = new CoreAllocator(8);
    await reconcileDockerReservations(allocator, {
      runDocker: fakeDocker([{ name: "rc-runner-a", cpuset: "0-3" }]),
    });

    await assert.rejects(
      reconcileDockerReservations(allocator, {
        runDocker: async () => ({ exitCode: 1, stdout: "" }),
      }),
      /docker ps exited 1/,
    );
    // Freeing cores on an unreadable daemon would hand a live container's CPUs
    // to the next Attempt, which is the contention this module prevents.
    assert.equal(allocator.freeCores, 4);
  });

  it("names a container running with no cpuset instead of accounting for it", async () => {
    const allocator = new CoreAllocator(8);
    const result = await reconcileDockerReservations(allocator, {
      runDocker: fakeDocker([{ name: "rc-runner-old", cpuset: "" }]),
    });

    assert.deepEqual(result.unpinned, ["rc-runner-old"]);
    assert.deepEqual(result.adopted, []);
    assert.equal(allocator.freeCores, 8);
  });

  it("issues no inspect at all on a Worker with no containers", async () => {
    const allocator = new CoreAllocator(8);
    const calls: string[][] = [];
    const result = await reconcileDockerReservations(allocator, {
      runDocker: async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: "" };
      },
    });

    assert.deepEqual(result, { adopted: [], released: [], unpinned: [] });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.slice(0, 3), ["ps", "--filter", "label=runner-center.profile"]);
  });
});
