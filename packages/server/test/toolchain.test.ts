import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findOnPath, parseCommandOverride } from "../src/graph/toolchain.js";

describe("parseCommandOverride", () => {
  it("splits a command string into argv0 and args", () => {
    expect(parseCommandOverride("cs launch foo --")).toEqual({ argv0: "cs", args: ["launch", "foo", "--"] });
  });
  it("returns undefined for unset or blank input", () => {
    expect(parseCommandOverride(undefined)).toBeUndefined();
    expect(parseCommandOverride("   ")).toBeUndefined();
  });
});

describe("findOnPath", () => {
  it("finds an executable in a PATH directory and ignores empty entries", () => {
    const dir = mkdtempSync(join(tmpdir(), "srev-path-"));
    writeFileSync(join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    expect(findOnPath("tool", { PATH: `:${dir}:` })).toBe(true);
    expect(findOnPath("missing", { PATH: dir })).toBe(false);
    expect(findOnPath("tool", {})).toBe(false);
  });
});
