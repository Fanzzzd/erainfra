import { convexTest, type TestConvex } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob("../convex/**/*.ts");
type Harness = TestConvex<typeof schema>;

function seedMachine(t: Harness, usedSlots = 0) {
  return t.run((ctx) =>
    ctx.db.insert("machines", {
      name: "ubuntu0",
      os: "linux",
      labels: [],
      maxSlots: 2,
      usedSlots,
      lastSeen: Date.now(),
      token: "machine-token",
    }),
  );
}

function readMachine(t: Harness, machineId: Id<"machines">) {
  return t.run((ctx) => ctx.db.get(machineId));
}

describe("admin.setMachineMaxSlots", () => {
  it("updates capacity and preserves the machine's other state", async () => {
    const t = convexTest(schema, modules);
    const machineId = await seedMachine(t);

    await t.mutation(internal.admin.setMachineMaxSlots, { machineId, maxSlots: 4 });

    expect(await readMachine(t, machineId)).toMatchObject({
      name: "ubuntu0",
      maxSlots: 4,
      usedSlots: 0,
    });
  });

  it.each([0, 1.5, 129])("rejects invalid capacity %s", async (maxSlots) => {
    const t = convexTest(schema, modules);
    const machineId = await seedMachine(t);

    await expect(
      t.mutation(internal.admin.setMachineMaxSlots, { machineId, maxSlots }),
    ).rejects.toThrow(/integer between 1 and 128/);
    expect((await readMachine(t, machineId))?.maxSlots).toBe(2);
  });

  it("does not lower capacity below the slots currently in use", async () => {
    const t = convexTest(schema, modules);
    const machineId = await seedMachine(t, 2);

    await expect(
      t.mutation(internal.admin.setMachineMaxSlots, { machineId, maxSlots: 1 }),
    ).rejects.toThrow(/2 active slot/);
    expect((await readMachine(t, machineId))?.maxSlots).toBe(2);
  });
});
