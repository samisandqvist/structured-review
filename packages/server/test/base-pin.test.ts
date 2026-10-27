// A session pins its base commit at creation: diffs keep showing the change
// against that commit after the base ref moves.
import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";
import { createSession, diffBase } from "../src/repo/sessions.js";

const root = mkdtempSync(join(tmpdir(), "srev-base-pin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (...a: string[]) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();

mkdirSync(join(root, "src"));
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
writeFileSync(join(root, "src/a.ts"), "export const a = 'one';\n");
git("add", "-A");
git("commit", "-qm", "base");
const baseSha = git("rev-parse", "HEAD");
git("checkout", "-q", "-b", "feature");
writeFileSync(join(root, "src/a.ts"), "export const a = 'two';\n");
git("commit", "-qam", "feature work");

describe("pinned base commit", () => {
  it("keeps diffing against the commit the session started from", async () => {
    const app = createApp({ db: createMemoryDatabase(), graphProvider: new StubGraphProvider(), repoRoot: root });
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ branch: "HEAD", baseRef: "main" }),
    });
    const { session } = (await created.json()) as { session: { id: string; baseSha: string } };
    expect(session.baseSha).toBe(baseSha);

    // main moves: a commit on top of the base that rewrites the same file.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "export const a = 'three';\n",
      encoding: "utf8",
    }).trim();
    const srcTree = execFileSync("git", ["mktree"], {
      cwd: root,
      input: `100644 blob ${blob}\ta.ts\n`,
      encoding: "utf8",
    }).trim();
    const top = execFileSync("git", ["mktree"], {
      cwd: root,
      input: `040000 tree ${srcTree}\tsrc\n`,
      encoding: "utf8",
    }).trim();
    git("update-ref", "refs/heads/main", git("commit-tree", top, "-p", baseSha, "-m", "main moves"));

    const nodes = (await (await app.request(`/api/sessions/${session.id}/nodes`)).json()) as {
      nodes: { id: string; file: string }[];
    };
    const node = nodes.nodes.find((n) => n.file === "src/a.ts")!;
    const detail = JSON.stringify(await (await app.request(`/api/sessions/${session.id}/nodes/${node.id}`)).json());
    expect(detail).toContain("one");
    expect(detail).not.toContain("three");
  });

  it("falls back to the base ref for sessions without a pinned commit", () => {
    const session = createSession(createMemoryDatabase(), "HEAD", "main");
    expect(diffBase(session)).toBe("main");
    expect(diffBase({ ...session, baseSha: baseSha })).toBe(baseSha);
  });
});
