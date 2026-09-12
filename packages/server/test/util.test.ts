import { describe, it, expect } from "vitest";
import { isTestFile } from "../src/util.js";

describe("isTestFile", () => {
  it("matches TS/JS test and spec files (existing behavior)", () => {
    expect(isTestFile("src/a.test.ts")).toBe(true);
    expect(isTestFile("src/a.spec.tsx")).toBe(true);
    expect(isTestFile("lib/b.test.mjs")).toBe(true);
    expect(isTestFile("src/__tests__/helpers.ts")).toBe(true);
    expect(isTestFile("src/app.ts")).toBe(false);
    expect(isTestFile("src/testing.ts")).toBe(false);
    expect(isTestFile("contest/x.ts")).toBe(false);
  });

  it("matches Python test conventions", () => {
    expect(isTestFile("mcp/svc/test_app.py")).toBe(true);
    expect(isTestFile("mcp/svc/app_test.py")).toBe(true);
    expect(isTestFile("mcp/svc/conftest.py")).toBe(true);
    expect(isTestFile("mcp/svc/tests/helpers.py")).toBe(true);
    expect(isTestFile("test_top.py")).toBe(true);
    expect(isTestFile("mcp/svc/app.py")).toBe(false);
    expect(isTestFile("mcp/svc/attest.py")).toBe(false); // no "_test." boundary
    expect(isTestFile("mcp/svc/contest_x.py")).toBe(false); // "test_" not at segment start
  });

  it("matches Java test conventions", () => {
    expect(isTestFile("introspector/src/test/java/com/x/FooTest.java")).toBe(true);
    expect(isTestFile("src/test/java/Foo.java")).toBe(true);
    expect(isTestFile("src/main/java/com/x/FooTest.java")).toBe(true); // *Test.java anywhere
    expect(isTestFile("src/main/java/com/x/FooIT.java")).toBe(true);
    expect(isTestFile("src/main/java/com/x/Foo.java")).toBe(false);
    expect(isTestFile("src/main/java/com/x/Splitter.java")).toBe(false);
  });
});
