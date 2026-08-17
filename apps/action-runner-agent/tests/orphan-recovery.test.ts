import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recoverFirecrackerOrphans } from "../orphan-recovery.ts";
import type { ProfileSpec } from "../readiness.ts";

const FIRECRACKER_PROFILE: ProfileSpec = {
  profile: "rc-linux-firecracker",
  executor: "firecracker",
  imageRelease: `ghcr.io/example/image@sha256:${"a".repeat(64)}`,
  vcpus: 2,
  memoryMiB: 4096,
};

describe("Agent startup orphan recovery", () => {
  it("invokes privileged recovery for a Firecracker Profile with the server live set", async () => {
    const calls: { file: string; args: string[]; input: string }[] = [];
    const recovered = await recoverFirecrackerOrphans(
      [FIRECRACKER_PROFILE],
      ["experiment-live", "attempt-live", "attempt-live"],
      {
        platform: "linux",
        socketAvailable: async () => true,
        run: async (file, args, options) => {
          calls.push({ file, args, input: options.input });
        },
      },
    );

    assert.equal(recovered, true);
    assert.deepEqual(calls, [
      {
        file: "runner-center-runtime",
        args: ["recover"],
        input: JSON.stringify(["experiment-live", "attempt-live"]),
      },
    ]);
  });

  it("does not invoke the runtime on Docker-only or Tart Workers", async () => {
    let calls = 0;
    const run = async () => {
      calls += 1;
    };
    const dockerProfile: ProfileSpec = { ...FIRECRACKER_PROFILE, executor: "docker" };
    const tartProfile: ProfileSpec = { ...FIRECRACKER_PROFILE, executor: "tart" };

    assert.equal(
      await recoverFirecrackerOrphans([dockerProfile], [], {
        platform: "linux",
        socketAvailable: async () => false,
        run,
      }),
      false,
    );
    assert.equal(
      await recoverFirecrackerOrphans([tartProfile], [], {
        platform: "darwin",
        socketAvailable: async () => true,
        run,
      }),
      false,
    );
    assert.equal(calls, 0);
  });

  it("recovers a configured runtime even after its last Profile was removed", async () => {
    let calls = 0;
    assert.equal(
      await recoverFirecrackerOrphans([], [], {
        platform: "linux",
        socketAvailable: async () => true,
        run: async () => {
          calls += 1;
        },
      }),
      true,
    );
    assert.equal(calls, 1);
  });
});
