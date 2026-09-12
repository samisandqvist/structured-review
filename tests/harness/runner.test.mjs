import { describe, expect, it } from "vitest";
import { runChecks } from "../../scripts/harness/runner.mjs";

describe("verification runner", () => {
  it("runs every required check and returns failure even when a later check passes", async () => {
    const seen = [];
    const checks = [
      { name: "types", command: ["types"] },
      { name: "tests", command: ["test"] },
      { name: "build", command: ["build"] },
    ];
    const result = await runChecks(checks, async (args) => {
      seen.push(args[0]);
      return args[0] === "test" ? 1 : 0;
    });
    expect(seen).toEqual(["types", "test", "build"]);
    expect(result.ok).toBe(false);
    expect(result.checks.map((c) => [c.name, c.exit])).toEqual([
      ["types", 0],
      ["tests", 1],
      ["build", 0],
    ]);
  });
  it("treats execution errors and signals as failures, never green", async () => {
    expect(
      (
        await runChecks([{ name: "scanner", command: [] }], async () => {
          throw new Error("unavailable");
        })
      ).ok,
    ).toBe(false);
    expect((await runChecks([{ name: "signal", command: [] }], async () => null)).ok).toBe(false);
  });
  it("accepts successful checks but rejects an empty required set", async () => {
    expect((await runChecks([{ name: "test", command: [] }], async () => 0)).ok).toBe(true);
    await expect(runChecks([], async () => 0)).rejects.toThrow(/empty/);
  });
});
