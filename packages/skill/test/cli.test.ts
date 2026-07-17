// packages/skill/test/cli.test.ts — pure pieces of the CLI: arg parsing and
// the serve reuse/spawn/conflict decision.
import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../src/cli.js";
import { decideServe } from "../src/serve.js";

describe("parseCliArgs", () => {
  it("joins positionals into a command and collects value flags", () => {
    const { command, flags } = parseCliArgs(["session", "create", "--branch", "feat/x", "--base", "main"]);
    expect(command).toBe("session create");
    expect(flags).toEqual({ branch: "feat/x", base: "main" });
  });

  it("treats auto/open/pretty as boolean flags", () => {
    const { command, flags } = parseCliArgs(["plan", "--session", "s1", "--auto", "--pretty"]);
    expect(command).toBe("plan");
    expect(flags).toEqual({ session: "s1", auto: true, pretty: true });
  });

  it("parses flags that take values even when a boolean flag follows", () => {
    const { flags } = parseCliArgs(["serve", "--repo", "/tmp/x", "--port", "4000"]);
    expect(flags).toEqual({ repo: "/tmp/x", port: "4000" });
  });
});

describe("decideServe", () => {
  const ROOT = "/home/x/repo";
  it("spawns when nothing answers /health", () => {
    expect(decideServe(null, ROOT)).toEqual({ action: "spawn" });
  });
  it("reuses a healthy hub serving the same repo", () => {
    expect(decideServe({ ok: true, repoRoot: ROOT, pid: 1 }, ROOT)).toEqual({ action: "reuse" });
  });
  it("conflicts on a hub serving a different repo", () => {
    const d = decideServe({ ok: true, repoRoot: "/other", pid: 42 }, ROOT);
    expect(d.action).toBe("conflict");
    expect((d as { reason: string }).reason).toContain("/other");
  });
  it("conflicts on an unknown /health responder", () => {
    const d = decideServe({ ok: true }, ROOT);
    expect(d.action).toBe("conflict");
  });
});
