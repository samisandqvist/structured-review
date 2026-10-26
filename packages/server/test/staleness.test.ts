// Staleness of a recorded working-tree snapshot.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot, staleness } from "../src/staleness.js";

const plain = mkdtempSync(join(tmpdir(), "srev-nogit-"));
afterAll(() => rmSync(plain, { recursive: true, force: true }));

describe("staleness outside a git repository", () => {
  it("records an empty snapshot and reports nothing", () => {
    expect(snapshot(plain)).toEqual({ headSha: "", repoFingerprint: "" });
    expect(staleness(plain, "abc", "fp")).toEqual({});
  });
});
