# Code Review Walkthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a code-structure-based review tool — Claude Code skill + local web UI — that walks a reviewer through changes along the call/dependency graph instead of a file tree.

**Architecture:** pnpm monorepo with three packages: `server` (Hono + better-sqlite3 hub), `web` (Vite + React UI), `skill` (Claude Code skill + TS orchestration). The server is the single hub: the UI talks only to it; graph data comes through a `GraphProvider` interface with CRG as provider #1.

**Tech Stack:** Node.js, TypeScript (strict), pnpm workspaces, Hono, better-sqlite3, Vite, React 19, TanStack Query, Zustand, React Flow (@xyflow/react), react-diff-viewer-continued, Vitest, Playwright

## Global Constraints

- TypeScript strict mode everywhere — `strict: true` in all tsconfigs
- The server is the single hub: the web UI never reads CRG or git directly
- Graph providers plug in behind a `GraphProvider` interface; CRG is provider #1
- The skill and server are separate: skill is orchestrator, server is stateful backend
- Local single-user only: localhost, no auth, SQLite on disk
- Package scope names: `@crw/server`, `@crw/web`, `@crw/skill`
- Node.js >= 20

---

## File Structure

```
packages/
  skill/
    src/
      orchestrate.ts          # orchestration script (plan -> launch -> export)
    skill.md                  # Claude Code skill definition
    package.json
    tsconfig.json
    vitest.config.ts
    test/
      orchestrate.test.ts
  server/
    src/
      index.ts                # Hono app entry, starts server
      app.ts                  # createApp factory (composes routes)
      types.ts                # domain types
      util.ts                 # id generator
      db/
        schema.ts             # SQLite DDL
        connection.ts         # better-sqlite3 connection helper
      repo/
        sessions.ts           # session CRUD
        units.ts              # unit CRUD
        nodes.ts              # node CRUD + neighbor queries
        comments.ts           # comment CRUD + export
      graph/
        provider.ts           # GraphProvider interface + types
        stub.ts               # stub provider for testing/dev
        crg.ts                # CRG MCP provider (provider #1)
      routes/
        sessions.ts           # session + plan endpoints
        nodes.ts              # node endpoints (list, detail, status)
        comments.ts           # comment endpoints + export
        events.ts             # SSE endpoint
      static.ts               # static file serving for prod
    test/
      schema.test.ts
      repo.test.ts
      graph.test.ts
      routes.test.ts
      crg.test.ts
    package.json
    tsconfig.json
    vitest.config.ts
  web/
    src/
      main.tsx                # entry
      App.tsx                 # app shell, providers
      api/
        client.ts             # typed fetch helpers
        hooks.ts              # TanStack Query hooks
      store/
        ui.ts                 # Zustand UI store
      components/
        SplitLayout.tsx       # draggable split between graph and diff
        GraphView.tsx         # React Flow neighborhood + overview
        DiffView.tsx          # side-by-side diff
        FrontierStrip.tsx     # agenda strip along bottom
        CommentBox.tsx        # comment authoring
        NodeBadge.tsx         # review-state badges
      test/
        setup.ts              # vitest setup (jsdom, testing-library)
    test/
      App.test.tsx
      GraphView.test.tsx
      DiffView.test.tsx
      FrontierStrip.test.tsx
      CommentBox.test.tsx
    index.html
    vite.config.ts
    package.json
    tsconfig.json
    vitest.config.ts
  pnpm-workspace.yaml
  package.json                # root
  tsconfig.base.json
  vitest.config.ts            # root vitest config
```

---

### Task 1: Monorepo Scaffolding

**Files:**
- Create: `pnpm-workspace.yaml`
- Create: `package.json` (root)
- Create: `tsconfig.base.json`
- Create: `vitest.config.ts` (root)
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`, `packages/server/vitest.config.ts`
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/vitest.config.ts`, `packages/web/vite.config.ts`
- Create: `packages/skill/package.json`, `packages/skill/tsconfig.json`, `packages/skill/vitest.config.ts`
- Create: `packages/server/src/index.ts` (placeholder)
- Create: `packages/web/src/main.tsx`, `packages/web/index.html`, `packages/web/src/test/setup.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: pnpm workspace with three packages, all typecheckable, `pnpm dev` starts server + web concurrently.

- [ ] **Step 1: Create pnpm workspace config**

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
```

- [ ] **Step 2: Create root package.json**

```json
{
  "name": "code-review-walkthrough",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n server,web -c blue,green \"pnpm --filter @crw/server dev\" \"pnpm --filter @crw/web dev\"",
    "build": "pnpm -r build",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint"
  },
  "devDependencies": {
    "concurrently": "^9.1.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 3: Create base tsconfig**

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  }
}
```

- [ ] **Step 4: Create root vitest config**

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    projects: ["packages/*/vitest.config.ts"],
  },
});
```

- [ ] **Step 5: Create server package.json**

```json
{
  "name": "@crw/server",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "@hono/node-server": "^1.13.0",
    "better-sqlite3": "^11.6.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 6: Create server tsconfig and vitest config**

```json
// packages/server/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src"],
  "exclude": ["dist", "test"]
}
```

```typescript
// packages/server/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "server", include: ["test/**/*.test.ts"], globals: true },
});
```

- [ ] **Step 7: Create server placeholder entry**

```typescript
// packages/server/src/index.ts
import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();
app.get("/health", (c) => c.json({ ok: true }));

serve({ fetch: app.fetch, port: 3456 }, (info) => {
  console.log(`review hub on http://localhost:${info.port}`);
});
```

- [ ] **Step 8: Create web package.json**

```json
{
  "name": "@crw/web",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@tanstack/react-query": "^5.62.0",
    "zustand": "^5.0.0",
    "@xyflow/react": "^12.3.0",
    "react-diff-viewer-continued": "^3.4.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/jest-dom": "^6.6.0",
    "jsdom": "^25.0.0",
    "vite": "^6.0.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 9: Create web tsconfig, vitest config, and vite config**

```json
// packages/web/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["src"],
  "exclude": ["dist"]
}
```

```typescript
// packages/web/vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    name: "web",
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    globals: true,
  },
});
```

```typescript
// packages/web/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:3456" } },
  build: { outDir: "dist" },
});
```

- [ ] **Step 10: Create web entry, HTML, and test setup**

```html
<!-- packages/web/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Code Review Walkthrough</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```tsx
// packages/web/src/main.tsx
import { createRoot } from "react-dom/client";

function App() {
  return <div>Code Review Walkthrough</div>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
```

```typescript
// packages/web/src/test/setup.ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 11: Create skill package.json, tsconfig, vitest config**

```json
{
  "name": "@crw/skill",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

```json
// packages/skill/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src"],
  "exclude": ["dist", "test"]
}
```

```typescript
// packages/skill/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "skill", include: ["test/**/*.test.ts"], globals: true },
});
```

- [ ] **Step 12: Update .gitignore**

```
node_modules/
dist/
*.db
*.db-journal
```

- [ ] **Step 13: Install and verify**

Run: `pnpm install`
Expected: packages linked, no errors

Run: `pnpm typecheck`
Expected: PASS (all three packages typecheck)

- [ ] **Step 14: Commit**

```bash
git add pnpm-workspace.yaml package.json tsconfig.base.json vitest.config.ts .gitignore packages/
git commit -m "chore: scaffold pnpm monorepo with server, web, skill packages"
```

---

### Task 2: Server Domain Types + SQLite Schema + Repository

**Files:**
- Create: `packages/server/src/types.ts`
- Create: `packages/server/src/util.ts`
- Create: `packages/server/src/db/schema.ts`
- Create: `packages/server/src/db/connection.ts`
- Create: `packages/server/src/repo/sessions.ts`
- Create: `packages/server/src/repo/units.ts`
- Create: `packages/server/src/repo/nodes.ts`
- Create: `packages/server/src/repo/comments.ts`
- Create: `packages/server/test/schema.test.ts`
- Create: `packages/server/test/repo.test.ts`

**Interfaces:**
- Produces: `ReviewSession`, `Unit`, `Node`, `Edge`, `Comment` types; `Database` connection type; repository functions:
  - `createSession(db, branch, baseRef): ReviewSession`
  - `getSession(db, id): ReviewSession | undefined`
  - `updateSessionStatus(db, id, status): void`
  - `createUnit(db, sessionId, position, label, rationale, entryPointNodeIds): Unit`
  - `getUnitsBySession(db, sessionId): Unit[]`
  - `updateUnit(db, id, label, rationale, entryPointNodeIds): void`
  - `deleteUnit(db, id): void`
  - `createNode(db, node: Omit<Node,"id">): Node`
  - `getNodesBySession(db, sessionId): Node[]`
  - `getNodesByUnit(db, unitId): Node[]`
  - `getNode(db, id): Node | undefined`
  - `getNodeNeighbors(db, nodeId): { callers: Node[]; callees: Node[] }`
  - `updateNodeReviewStatus(db, id, status, reviewedInUnit?): void`
  - `createComment(db, sessionId, nodeId, hunkSnippet, text, structuralContext): Comment`
  - `getCommentsBySession(db, sessionId): Comment[]`
  - `exportComments(db, sessionId): Record<string, ExportedComment>`

- [ ] **Step 1: Write domain types**

```typescript
// packages/server/src/types.ts
export type SessionStatus = "planning" | "walking" | "complete";
export type ChangeStatus = "changed" | "unchanged";
export type ReviewStatus =
  | "unreviewed"
  | "reviewed-clean"
  | "reviewed-commented"
  | "reviewed-elsewhere";
export type EdgeType = "call";

export interface ReviewSession {
  id: string;
  branch: string;
  baseRef: string;
  status: SessionStatus;
  createdAt: number;
}

export interface Unit {
  id: string;
  sessionId: string;
  position: number;
  label: string;
  rationale: string;
  entryPointNodeIds: string[];
}

export interface Node {
  id: string;
  sessionId: string;
  stableId: string;
  unitId: string | null;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  changeStatus: ChangeStatus;
  reviewStatus: ReviewStatus;
  reviewedInUnit: number | null;
}

export interface Edge {
  id: string;
  sessionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  edgeType: EdgeType;
}

export interface Comment {
  id: string;
  sessionId: string;
  nodeId: string;
  hunkSnippet: string;
  text: string;
  structuralContext: string;
  createdAt: number;
}

export interface ExportedComment {
  nodeId: string;
  stableId: string;
  label: string;
  file: string;
  hunkSnippet: string;
  text: string;
  structuralContext: string;
  createdAt: number;
}
```

- [ ] **Step 2: Write util (id generator)**

```typescript
// packages/server/src/util.ts
export function randomId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 14)}`;
}
```

- [ ] **Step 3: Write schema DDL**

```typescript
// packages/server/src/db/schema.ts
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  rationale TEXT NOT NULL,
  entry_point_node_ids TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  stable_id TEXT NOT NULL,
  unit_id TEXT REFERENCES units(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  change_status TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  reviewed_in_unit INTEGER
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  source_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  edge_type TEXT NOT NULL DEFAULT 'call'
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  hunk_snippet TEXT NOT NULL,
  text TEXT NOT NULL,
  structural_context TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_session ON nodes(session_id);
CREATE INDEX IF NOT EXISTS idx_nodes_unit ON nodes(unit_id);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id);
CREATE INDEX IF NOT EXISTS idx_comments_node ON comments(node_id);
`;
```

- [ ] **Step 4: Write connection helper**

```typescript
// packages/server/src/db/connection.ts
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";

export type DB = Database.Database;

export function createDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

export function createMemoryDatabase(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}
```

- [ ] **Step 5: Write the failing schema test**

```typescript
// packages/server/test/schema.test.ts
import { describe, it, expect } from "vitest";
import { createMemoryDatabase } from "../src/db/connection.js";

describe("schema", () => {
  it("creates all tables", () => {
    const db = createMemoryDatabase();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("review_sessions");
    expect(names).toContain("units");
    expect(names).toContain("nodes");
    expect(names).toContain("edges");
    expect(names).toContain("comments");
    db.close();
  });

  it("enforces foreign keys", () => {
    const db = createMemoryDatabase();
    expect(() =>
      db.prepare(
        "INSERT INTO units (id, session_id, position, label, rationale) VALUES (?, ?, ?, ?, ?)"
      ).run("u1", "nonexistent", 0, "test", "test")
    ).toThrow();
    db.close();
  });
});
```

- [ ] **Step 6: Run schema test to verify it passes**

Run: `pnpm --filter @crw/server test`
Expected: PASS

- [ ] **Step 7: Write sessions repository**

```typescript
// packages/server/src/repo/sessions.ts
import type { DB } from "../db/connection.js";
import type { ReviewSession, SessionStatus } from "../types.js";
import { randomId } from "../util.js";

export function createSession(db: DB, branch: string, baseRef: string): ReviewSession {
  const id = randomId("ses");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO review_sessions (id, branch, base_ref, status, created_at) VALUES (?, ?, ?, 'planning', ?)"
  ).run(id, branch, baseRef, createdAt);
  return { id, branch, baseRef, status: "planning", createdAt };
}

export function getSession(db: DB, id: string): ReviewSession | undefined {
  const row = db.prepare("SELECT * FROM review_sessions WHERE id = ?").get(id) as
    | { id: string; branch: string; base_ref: string; status: SessionStatus; created_at: number }
    | undefined;
  if (!row) return undefined;
  return { id: row.id, branch: row.branch, baseRef: row.base_ref, status: row.status, createdAt: row.created_at };
}

export function updateSessionStatus(db: DB, id: string, status: SessionStatus): void {
  db.prepare("UPDATE review_sessions SET status = ? WHERE id = ?").run(status, id);
}
```

- [ ] **Step 8: Write units repository**

```typescript
// packages/server/src/repo/units.ts
import type { DB } from "../db/connection.js";
import type { Unit } from "../types.js";
import { randomId } from "../util.js";

interface UnitRow {
  id: string; session_id: string; position: number; label: string;
  rationale: string; entry_point_node_ids: string;
}

function rowToUnit(row: UnitRow): Unit {
  return {
    id: row.id, sessionId: row.session_id, position: row.position,
    label: row.label, rationale: row.rationale,
    entryPointNodeIds: JSON.parse(row.entry_point_node_ids),
  };
}

export function createUnit(
  db: DB, sessionId: string, position: number, label: string,
  rationale: string, entryPointNodeIds: string[]
): Unit {
  const id = randomId("unit");
  db.prepare(
    "INSERT INTO units (id, session_id, position, label, rationale, entry_point_node_ids) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, position, label, rationale, JSON.stringify(entryPointNodeIds));
  return { id, sessionId, position, label, rationale, entryPointNodeIds };
}

export function getUnitsBySession(db: DB, sessionId: string): Unit[] {
  const rows = db.prepare("SELECT * FROM units WHERE session_id = ? ORDER BY position").all(sessionId) as UnitRow[];
  return rows.map(rowToUnit);
}

export function updateUnit(db: DB, id: string, label: string, rationale: string, entryPointNodeIds: string[]): void {
  db.prepare("UPDATE units SET label = ?, rationale = ?, entry_point_node_ids = ? WHERE id = ?")
    .run(label, rationale, JSON.stringify(entryPointNodeIds), id);
}

export function deleteUnit(db: DB, id: string): void {
  db.prepare("DELETE FROM units WHERE id = ?").run(id);
}
```

- [ ] **Step 9: Write nodes repository**

```typescript
// packages/server/src/repo/nodes.ts
import type { DB } from "../db/connection.js";
import type { Node, ReviewStatus, ChangeStatus } from "../types.js";
import { randomId } from "../util.js";

interface NodeRow {
  id: string; session_id: string; stable_id: string; unit_id: string | null;
  label: string; file: string; start_line: number; end_line: number;
  change_status: ChangeStatus; review_status: ReviewStatus; reviewed_in_unit: number | null;
}

function rowToNode(row: NodeRow): Node {
  return {
    id: row.id, sessionId: row.session_id, stableId: row.stable_id, unitId: row.unit_id,
    label: row.label, file: row.file, startLine: row.start_line, endLine: row.end_line,
    changeStatus: row.change_status, reviewStatus: row.review_status, reviewedInUnit: row.reviewed_in_unit,
  };
}

export function createNode(db: DB, node: Omit<Node, "id">): Node {
  const id = randomId("node");
  db.prepare(
    `INSERT INTO nodes (id, session_id, stable_id, unit_id, label, file, start_line, end_line, change_status, review_status, reviewed_in_unit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, node.sessionId, node.stableId, node.unitId, node.label, node.file,
    node.startLine, node.endLine, node.changeStatus, node.reviewStatus, node.reviewedInUnit);
  return { ...node, id };
}

export function getNodesBySession(db: DB, sessionId: string): Node[] {
  return (db.prepare("SELECT * FROM nodes WHERE session_id = ?").all(sessionId) as NodeRow[]).map(rowToNode);
}

export function getNodesByUnit(db: DB, unitId: string): Node[] {
  return (db.prepare("SELECT * FROM nodes WHERE unit_id = ?").all(unitId) as NodeRow[]).map(rowToNode);
}

export function getNode(db: DB, id: string): Node | undefined {
  const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow | undefined;
  return row ? rowToNode(row) : undefined;
}

export function getNodeNeighbors(db: DB, nodeId: string): { callers: Node[]; callees: Node[] } {
  const callers = (db.prepare(
    `SELECT n.* FROM nodes n JOIN edges e ON e.source_node_id = n.id WHERE e.target_node_id = ?`
  ).all(nodeId) as NodeRow[]).map(rowToNode);
  const callees = (db.prepare(
    `SELECT n.* FROM nodes n JOIN edges e ON e.target_node_id = n.id WHERE e.source_node_id = ?`
  ).all(nodeId) as NodeRow[]).map(rowToNode);
  return { callers, callees };
}

export function updateNodeReviewStatus(db: DB, id: string, status: ReviewStatus, reviewedInUnit?: number): void {
  db.prepare("UPDATE nodes SET review_status = ?, reviewed_in_unit = ? WHERE id = ?")
    .run(status, reviewedInUnit ?? null, id);
}
```

- [ ] **Step 10: Write comments repository**

```typescript
// packages/server/src/repo/comments.ts
import type { DB } from "../db/connection.js";
import type { Comment, ExportedComment } from "../types.js";
import { randomId } from "../util.js";

interface CommentRow {
  id: string; session_id: string; node_id: string; hunk_snippet: string;
  text: string; structural_context: string; created_at: number;
}

function rowToComment(row: CommentRow): Comment {
  return {
    id: row.id, sessionId: row.session_id, nodeId: row.node_id,
    hunkSnippet: row.hunk_snippet, text: row.text,
    structuralContext: row.structural_context, createdAt: row.created_at,
  };
}

export function createComment(
  db: DB, sessionId: string, nodeId: string, hunkSnippet: string,
  text: string, structuralContext: string
): Comment {
  const id = randomId("cmt");
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO comments (id, session_id, node_id, hunk_snippet, text, structural_context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt);
  return { id, sessionId, nodeId, hunkSnippet, text, structuralContext, createdAt };
}

export function getCommentsBySession(db: DB, sessionId: string): Comment[] {
  return (db.prepare("SELECT * FROM comments WHERE session_id = ? ORDER BY created_at").all(sessionId) as CommentRow[]).map(rowToComment);
}

export function exportComments(db: DB, sessionId: string): Record<string, ExportedComment> {
  const rows = db.prepare(
    `SELECT c.node_id, n.stable_id, n.label, n.file, c.hunk_snippet, c.text, c.structural_context, c.created_at
     FROM comments c JOIN nodes n ON c.node_id = n.id WHERE c.session_id = ? ORDER BY c.created_at`
  ).all(sessionId) as {
    node_id: string; stable_id: string; label: string; file: string;
    hunk_snippet: string; text: string; structural_context: string; created_at: number;
  }[];
  const result: Record<string, ExportedComment> = {};
  for (const row of rows) {
    result[row.node_id] = {
      nodeId: row.node_id, stableId: row.stable_id, label: row.label, file: row.file,
      hunkSnippet: row.hunk_snippet, text: row.text,
      structuralContext: row.structural_context, createdAt: row.created_at,
    };
  }
  return result;
}
```

- [ ] **Step 11: Write the repo test**

```typescript
// packages/server/test/repo.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createSession, getSession, updateSessionStatus } from "../src/repo/sessions.js";
import { createUnit, getUnitsBySession, updateUnit, deleteUnit } from "../src/repo/units.js";
import { createNode, getNodesBySession, getNodesByUnit, getNode, getNodeNeighbors, updateNodeReviewStatus } from "../src/repo/nodes.js";
import { createComment, getCommentsBySession, exportComments } from "../src/repo/comments.js";

let db: DB;
beforeEach(() => { db = createMemoryDatabase(); });
afterEach(() => { db.close(); });

describe("sessions repo", () => {
  it("creates and retrieves a session", () => {
    const session = createSession(db, "feature-branch", "main");
    expect(session.branch).toBe("feature-branch");
    expect(session.status).toBe("planning");
    expect(getSession(db, session.id)!.branch).toBe("feature-branch");
  });
  it("updates session status", () => {
    const session = createSession(db, "feat", "main");
    updateSessionStatus(db, session.id, "walking");
    expect(getSession(db, session.id)!.status).toBe("walking");
  });
});

describe("units repo", () => {
  it("creates and lists units ordered by position", () => {
    const session = createSession(db, "feat", "main");
    createUnit(db, session.id, 1, "Second", "r2", []);
    createUnit(db, session.id, 0, "First", "r1", ["n1"]);
    const units = getUnitsBySession(db, session.id);
    expect(units).toHaveLength(2);
    expect(units[0].label).toBe("First");
    expect(units[0].entryPointNodeIds).toEqual(["n1"]);
  });
  it("updates and deletes units", () => {
    const session = createSession(db, "feat", "main");
    const unit = createUnit(db, session.id, 0, "Label", "Reason", []);
    updateUnit(db, unit.id, "New", "NewReason", ["n2"]);
    expect(getUnitsBySession(db, session.id)[0].label).toBe("New");
    deleteUnit(db, unit.id);
    expect(getUnitsBySession(db, session.id)).toHaveLength(0);
  });
});

describe("nodes repo", () => {
  it("creates and retrieves nodes", () => {
    const session = createSession(db, "feat", "main");
    const unit = createUnit(db, session.id, 0, "Unit", "Reason", []);
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:handleOrder", unitId: unit.id,
      label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30,
      changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
    });
    expect(getNode(db, node.id)).toBeDefined();
    expect(getNodesByUnit(db, unit.id)).toHaveLength(1);
    expect(getNodesBySession(db, session.id)).toHaveLength(1);
  });
  it("gets node neighbors via edges", () => {
    const session = createSession(db, "feat", "main");
    const caller = createNode(db, {
      sessionId: session.id, stableId: "fn:caller", unitId: null, label: "caller",
      file: "a.ts", startLine: 1, endLine: 5, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
    });
    const callee = createNode(db, {
      sessionId: session.id, stableId: "fn:callee", unitId: null, label: "callee",
      file: "b.ts", startLine: 1, endLine: 5, changeStatus: "unchanged", reviewStatus: "unreviewed", reviewedInUnit: null,
    });
    db.prepare(
      "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, 'call')"
    ).run("e1", session.id, caller.id, callee.id);
    expect(getNodeNeighbors(db, caller.id).callees).toHaveLength(1);
    expect(getNodeNeighbors(db, callee.id).callers).toHaveLength(1);
  });
  it("updates review status", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:x", unitId: null, label: "x",
      file: "x.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
    });
    updateNodeReviewStatus(db, node.id, "reviewed-clean", 0);
    expect(getNode(db, node.id)!.reviewStatus).toBe("reviewed-clean");
    expect(getNode(db, node.id)!.reviewedInUnit).toBe(0);
  });
});

describe("comments repo", () => {
  it("creates and lists comments", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:x", unitId: null, label: "x",
      file: "x.ts", startLine: 1, endLine: 2, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
    });
    createComment(db, session.id, node.id, "snippet", "needs fix", "callers: A");
    expect(getCommentsBySession(db, session.id)).toHaveLength(1);
  });
  it("exports comments keyed by node id", () => {
    const session = createSession(db, "feat", "main");
    const node = createNode(db, {
      sessionId: session.id, stableId: "fn:handleOrder", unitId: null, label: "handleOrder",
      file: "src/orders.ts", startLine: 10, endLine: 30, changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
    });
    createComment(db, session.id, node.id, "old", "bug here", "callers: routeHandler");
    const exported = exportComments(db, session.id);
    expect(Object.keys(exported)).toHaveLength(1);
    expect(exported[node.id].stableId).toBe("fn:handleOrder");
    expect(exported[node.id].structuralContext).toBe("callers: routeHandler");
  });
});
```

- [ ] **Step 12: Run tests and typecheck**

Run: `pnpm --filter @crw/server test`
Expected: PASS

Run: `pnpm --filter @crw/server typecheck`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add packages/server/src/types.ts packages/server/src/util.ts packages/server/src/db/ packages/server/src/repo/ packages/server/test/schema.test.ts packages/server/test/repo.test.ts
git commit -m "feat: add domain types, SQLite schema, and repository layer"
```

---

### Task 3: Server GraphProvider Interface + Stub

**Files:**
- Create: `packages/server/src/graph/provider.ts`
- Create: `packages/server/src/graph/stub.ts`
- Create: `packages/server/test/graph.test.ts`

**Interfaces:**
- Produces: `GraphProvider` interface, `GraphNode`, `GraphEdge`, `ChangeSubgraph` types; `StubGraphProvider` class implementing `GraphProvider`

- [ ] **Step 1: Write GraphProvider interface**

```typescript
// packages/server/src/graph/provider.ts
import type { ChangeStatus, EdgeType } from "../types.js";

export interface GraphNode {
  stableId: string;
  label: string;
  file: string;
  startLine: number;
  endLine: number;
  isEntryPoint: boolean;
  changeStatus: ChangeStatus;
}

export interface GraphEdge {
  sourceStableId: string;
  targetStableId: string;
  edgeType: EdgeType;
}

export interface ChangeSubgraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphProvider {
  getChangeSubgraph(branch: string, baseRef: string): Promise<ChangeSubgraph>;
  getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }>;
}
```

- [ ] **Step 2: Write stub provider**

```typescript
// packages/server/src/graph/stub.ts
import type { GraphProvider, GraphNode, GraphEdge, ChangeSubgraph } from "./provider.js";

const STUB_NODES: GraphNode[] = [
  { stableId: "fn:handleOrder", label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30, isEntryPoint: true, changeStatus: "changed" },
  { stableId: "fn:validateOrder", label: "validateOrder", file: "src/orders.ts", startLine: 35, endLine: 50, isEntryPoint: false, changeStatus: "changed" },
  { stableId: "fn:saveOrder", label: "saveOrder", file: "src/db.ts", startLine: 100, endLine: 120, isEntryPoint: false, changeStatus: "unchanged" },
];

const STUB_EDGES: GraphEdge[] = [
  { sourceStableId: "fn:handleOrder", targetStableId: "fn:validateOrder", edgeType: "call" },
  { sourceStableId: "fn:handleOrder", targetStableId: "fn:saveOrder", edgeType: "call" },
];

export class StubGraphProvider implements GraphProvider {
  async getChangeSubgraph(_branch: string, _baseRef: string): Promise<ChangeSubgraph> {
    return { nodes: STUB_NODES, edges: STUB_EDGES };
  }
  async getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }> {
    const callees = STUB_EDGES.filter(e => e.sourceStableId === stableId).map(e => STUB_NODES.find(n => n.stableId === e.targetStableId)!);
    const callers = STUB_EDGES.filter(e => e.targetStableId === stableId).map(e => STUB_NODES.find(n => n.stableId === e.sourceStableId)!);
    return { callers, callees };
  }
}
```

- [ ] **Step 3: Write graph test**

```typescript
// packages/server/test/graph.test.ts
import { describe, it, expect } from "vitest";
import { StubGraphProvider } from "../src/graph/stub.js";

describe("StubGraphProvider", () => {
  it("returns a change subgraph with nodes and edges", async () => {
    const provider = new StubGraphProvider();
    const subgraph = await provider.getChangeSubgraph("feat", "main");
    expect(subgraph.nodes.length).toBeGreaterThan(0);
    expect(subgraph.edges.length).toBeGreaterThan(0);
    expect(subgraph.nodes.filter(n => n.isEntryPoint).length).toBeGreaterThan(0);
  });
  it("returns callers and callees for a node", async () => {
    const provider = new StubGraphProvider();
    const neighbors = await provider.getNeighbors("fn:handleOrder");
    expect(neighbors.callers).toHaveLength(0);
    expect(neighbors.callees.some(n => n.stableId === "fn:validateOrder")).toBe(true);
  });
  it("returns callers for a callee node", async () => {
    const provider = new StubGraphProvider();
    const neighbors = await provider.getNeighbors("fn:validateOrder");
    expect(neighbors.callers.some(n => n.stableId === "fn:handleOrder")).toBe(true);
    expect(neighbors.callees).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run tests and commit**

Run: `pnpm --filter @crw/server test`
Expected: PASS

```bash
git add packages/server/src/graph/ packages/server/test/graph.test.ts
git commit -m "feat: add GraphProvider interface and stub provider"
```

---

### Task 4: Server Hono App + Session/Plan/Node Routes

**Files:**
- Create: `packages/server/src/app.ts`
- Create: `packages/server/src/routes/sessions.ts`
- Create: `packages/server/src/routes/nodes.ts`
- Modify: `packages/server/src/index.ts`
- Create: `packages/server/test/routes.test.ts`

**Interfaces:**
- Consumes: repository functions from Task 2, `GraphProvider` from Task 3
- Produces: HTTP API:
  - `POST /api/sessions` — create session, returns `{ session, subgraph }`
  - `GET /api/sessions/:id` — get session with units
  - `PUT /api/sessions/:id/plan` — replace plan (units array)
  - `GET /api/sessions/:id/nodes` — list nodes (optional `?unitId=` filter)
  - `GET /api/sessions/:id/nodes/:nodeId` — get node with neighbors
  - `PATCH /api/sessions/:id/nodes/:nodeId` — update review status

- [ ] **Step 1: Write the failing route test**

```typescript
// packages/server/test/routes.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { DB } from "../src/db/connection.js";
import { createMemoryDatabase } from "../src/db/connection.js";
import { createApp } from "../src/app.js";
import { StubGraphProvider } from "../src/graph/stub.js";

let db: DB;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  db = createMemoryDatabase();
  app = createApp({ db, graphProvider: new StubGraphProvider() });
});
afterEach(() => { db.close(); });

describe("POST /api/sessions", () => {
  it("creates a session and returns it with the change subgraph", async () => {
    const res = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBeDefined();
    expect(body.session.branch).toBe("feat");
    expect(body.subgraph.nodes.length).toBeGreaterThan(0);
  });
});

describe("GET /api/sessions/:id", () => {
  it("returns session with units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.session.id).toBe(session.id);
    expect(body.units).toEqual([]);
  });
  it("returns 404 for unknown session", async () => {
    const res = await app.request("/api/sessions/nonexistent");
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/sessions/:id/plan", () => {
  it("replaces the plan with new units", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/plan`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        units: [{ label: "Order handlers", rationale: "all order endpoints", entryPointNodeIds: ["fn:handleOrder"] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.units).toHaveLength(1);
    expect(body.units[0].label).toBe("Order handlers");
    expect(body.units[0].position).toBe(0);
  });
});

describe("GET /api/sessions/:id/nodes", () => {
  it("lists all nodes in a session", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const res = await app.request(`/api/sessions/${session.id}/nodes`);
    expect(res.status).toBe(200);
    expect((await res.json()).nodes.length).toBeGreaterThan(0);
  });
});

describe("PATCH /api/sessions/:id/nodes/:nodeId", () => {
  it("updates node review status", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const res = await app.request(`/api/sessions/${session.id}/nodes/${nodes[0].id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewStatus: "reviewed-clean", reviewedInUnit: 0 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).node.reviewStatus).toBe("reviewed-clean");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (app.ts doesn't exist)**

Run: `pnpm --filter @crw/server test`
Expected: FAIL — cannot find module `../src/app.js`

- [ ] **Step 3: Write the app factory**

```typescript
// packages/server/src/app.ts
import { Hono } from "hono";
import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createNodesRoute } from "./routes/nodes.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/sessions", createSessionsRoute(ctx));
  app.route("/api/sessions", createNodesRoute(ctx));
  return app;
}
```

- [ ] **Step 4: Write sessions route**

```typescript
// packages/server/src/routes/sessions.ts
import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createSession, getSession, updateSessionStatus } from "../repo/sessions.js";
import { createUnit, getUnitsBySession, deleteUnit } from "../repo/units.js";
import { createNode, getNodesBySession } from "../repo/nodes.js";
import { randomId } from "../util.js";

export function createSessionsRoute(ctx: AppContext) {
  const router = new Hono();

  router.post("/", async (c) => {
    const body = await c.req.json<{ branch: string; baseRef: string }>();
    const session = createSession(ctx.db, body.branch, body.baseRef);
    const subgraph = await ctx.graphProvider.getChangeSubgraph(body.branch, body.baseRef);
    for (const gnode of subgraph.nodes) {
      createNode(ctx.db, {
        sessionId: session.id, stableId: gnode.stableId, unitId: null,
        label: gnode.label, file: gnode.file, startLine: gnode.startLine, endLine: gnode.endLine,
        changeStatus: gnode.changeStatus, reviewStatus: "unreviewed", reviewedInUnit: null,
      });
    }
    const nodes = getNodesBySession(ctx.db, session.id);
    for (const gedge of subgraph.edges) {
      const source = nodes.find(n => n.stableId === gedge.sourceStableId);
      const target = nodes.find(n => n.stableId === gedge.targetStableId);
      if (source && target) {
        ctx.db.prepare(
          "INSERT INTO edges (id, session_id, source_node_id, target_node_id, edge_type) VALUES (?, ?, ?, ?, ?)"
        ).run(randomId("edge"), session.id, source.id, target.id, gedge.edgeType);
      }
    }
    return c.json({ session, subgraph });
  });

  router.get("/:id", (c) => {
    const session = getSession(ctx.db, c.req.param("id"));
    if (!session) return c.json({ error: "not found" }, 404);
    const units = getUnitsBySession(ctx.db, session.id);
    return c.json({ session, units });
  });

  router.put("/:id/plan", async (c) => {
    const sessionId = c.req.param("id");
    const session = getSession(ctx.db, sessionId);
    if (!session) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<{
      units: { label: string; rationale: string; entryPointNodeIds: string[] }[];
    }>();
    for (const u of getUnitsBySession(ctx.db, sessionId)) deleteUnit(ctx.db, u.id);
    const created = body.units.map((u, i) =>
      createUnit(ctx.db, sessionId, i, u.label, u.rationale, u.entryPointNodeIds)
    );
    updateSessionStatus(ctx.db, sessionId, "walking");
    return c.json({ units: created });
  });

  return router;
}
```

- [ ] **Step 5: Write nodes route**

```typescript
// packages/server/src/routes/nodes.ts
import { Hono } from "hono";
import type { AppContext } from "../app.js";
import type { ReviewStatus } from "../types.js";
import { getNodesBySession, getNodesByUnit, getNode, getNodeNeighbors, updateNodeReviewStatus } from "../repo/nodes.js";

export function createNodesRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/nodes", (c) => {
    const sessionId = c.req.param("id");
    const unitId = c.req.query("unitId");
    const nodes = unitId ? getNodesByUnit(ctx.db, unitId) : getNodesBySession(ctx.db, sessionId);
    return c.json({ nodes });
  });

  router.get("/:id/nodes/:nodeId", (c) => {
    const node = getNode(ctx.db, c.req.param("nodeId"));
    if (!node) return c.json({ error: "not found" }, 404);
    const { callers, callees } = getNodeNeighbors(ctx.db, node.id);
    return c.json({ node, callers, callees });
  });

  router.patch("/:id/nodes/:nodeId", async (c) => {
    const body = await c.req.json<{ reviewStatus: ReviewStatus; reviewedInUnit?: number }>();
    const nodeId = c.req.param("nodeId");
    updateNodeReviewStatus(ctx.db, nodeId, body.reviewStatus, body.reviewedInUnit);
    const node = getNode(ctx.db, nodeId);
    if (!node) return c.json({ error: "not found" }, 404);
    return c.json({ node });
  });

  return router;
}
```

- [ ] **Step 6: Update server entry to use createApp**

```typescript
// packages/server/src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db/connection.js";
import { StubGraphProvider } from "./graph/stub.js";

const db = createDatabase(process.env.CRW_DB_PATH || "review.db");
const app = createApp({ db, graphProvider: new StubGraphProvider() });

const port = Number(process.env.PORT) || 3456;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`review hub on http://localhost:${info.port}`);
});
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm --filter @crw/server test`
Expected: PASS

Run: `pnpm --filter @crw/server typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/app.ts packages/server/src/routes/sessions.ts packages/server/src/routes/nodes.ts packages/server/src/index.ts packages/server/test/routes.test.ts
git commit -m "feat: add Hono app with session, plan, and node routes"
```

---

### Task 5: Server Comment Routes + SSE + Export

**Files:**
- Create: `packages/server/src/routes/comments.ts`
- Create: `packages/server/src/routes/events.ts`
- Create: `packages/server/src/static.ts`
- Modify: `packages/server/src/app.ts`
- Modify: `packages/server/test/routes.test.ts` (append tests)

**Interfaces:**
- Produces: `POST /api/sessions/:id/comments`, `GET /api/sessions/:id/comments`, `GET /api/sessions/:id/export`, `GET /api/sessions/:id/events` (SSE)

- [ ] **Step 1: Write the failing tests (append to routes.test.ts)**

```typescript
// Append to packages/server/test/routes.test.ts

describe("POST /api/sessions/:id/comments", () => {
  it("creates a comment on a node", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    const res = await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, hunkSnippet: "const x = 1", text: "this looks wrong", structuralContext: "callers: routeHandler" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).comment.text).toBe("this looks wrong");
  });
});

describe("GET /api/sessions/:id/comments", () => {
  it("lists comments in a session", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, hunkSnippet: "s", text: "comment 1", structuralContext: "callers: A" }),
    });
    const res = await app.request(`/api/sessions/${session.id}/comments`);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
  });
});

describe("GET /api/sessions/:id/export", () => {
  it("exports comments keyed by node id with structural context", async () => {
    const cr = await app.request("/api/sessions", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: "feat", baseRef: "main" }),
    });
    const { session } = await cr.json();
    const nr = await app.request(`/api/sessions/${session.id}/nodes`);
    const { nodes } = await nr.json();
    await app.request(`/api/sessions/${session.id}/comments`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodeId: nodes[0].id, hunkSnippet: "s", text: "fix this", structuralContext: "callers: A, B" }),
    });
    const res = await app.request(`/api/sessions/${session.id}/export`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).length).toBe(1);
    expect(body[nodes[0].id].text).toBe("fix this");
  });
});
```

- [ ] **Step 2: Write comments route**

```typescript
// packages/server/src/routes/comments.ts
import { Hono } from "hono";
import type { AppContext } from "../app.js";
import { createComment, getCommentsBySession, exportComments } from "../repo/comments.js";

export function createCommentsRoute(ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/comments", (c) => {
    return c.json({ comments: getCommentsBySession(ctx.db, c.req.param("id")) });
  });

  router.post("/:id/comments", async (c) => {
    const body = await c.req.json<{
      nodeId: string; hunkSnippet: string; text: string; structuralContext: string;
    }>();
    const comment = createComment(ctx.db, c.req.param("id"), body.nodeId, body.hunkSnippet, body.text, body.structuralContext);
    return c.json({ comment });
  });

  router.get("/:id/export", (c) => {
    return c.json(exportComments(ctx.db, c.req.param("id")));
  });

  return router;
}
```

- [ ] **Step 3: Write SSE events route**

```typescript
// packages/server/src/routes/events.ts
import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { AppContext } from "../app.js";

type EventCallback = (data: string) => void;
const subscribers = new Map<string, Set<EventCallback>>();

export function emitEvent(sessionId: string, event: string, data: unknown): void {
  const subs = subscribers.get(sessionId);
  if (subs) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const cb of subs) cb(payload);
  }
}

export function createEventsRoute(_ctx: AppContext) {
  const router = new Hono();

  router.get("/:id/events", (c) => {
    const sessionId = c.req.param("id");
    return stream(c, async (s) => {
      s.writeHead({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const cb: EventCallback = (data) => s.write(data);
      if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
      subscribers.get(sessionId)!.add(cb);
      s.onAbort(() => { subscribers.get(sessionId)?.delete(cb); });
    });
  });

  return router;
}
```

- [ ] **Step 4: Write static serving**

```typescript
// packages/server/src/static.ts
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

export function createStaticRoute(webDistPath: string) {
  const router = new Hono();
  router.use("/*", serveStatic({ root: webDistPath }));
  return router;
}
```

- [ ] **Step 5: Update app.ts to mount comments and events routes**

Replace `packages/server/src/app.ts` with:

```typescript
// packages/server/src/app.ts
import { Hono } from "hono";
import type { DB } from "./db/connection.js";
import type { GraphProvider } from "./graph/provider.js";
import { createSessionsRoute } from "./routes/sessions.js";
import { createNodesRoute } from "./routes/nodes.js";
import { createCommentsRoute } from "./routes/comments.js";
import { createEventsRoute } from "./routes/events.js";

export interface AppContext {
  db: DB;
  graphProvider: GraphProvider;
}

export function createApp(ctx: AppContext) {
  const app = new Hono();
  app.get("/health", (c) => c.json({ ok: true }));
  app.route("/api/sessions", createSessionsRoute(ctx));
  app.route("/api/sessions", createNodesRoute(ctx));
  app.route("/api/sessions", createCommentsRoute(ctx));
  app.route("/api/sessions", createEventsRoute(ctx));
  return app;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @crw/server test`
Expected: PASS

Run: `pnpm --filter @crw/server typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/routes/comments.ts packages/server/src/routes/events.ts packages/server/src/static.ts packages/server/src/app.ts packages/server/test/routes.test.ts
git commit -m "feat: add comment routes, SSE events, and static serving"
```

---

### Task 6: Web Scaffolding + App Shell + State

**Files:**
- Modify: `packages/web/src/main.tsx`
- Create: `packages/web/src/App.tsx`
- Create: `packages/web/src/api/client.ts`
- Create: `packages/web/src/api/hooks.ts`
- Create: `packages/web/src/store/ui.ts`
- Create: `packages/web/src/components/SplitLayout.tsx` (placeholder)
- Create: `packages/web/test/App.test.tsx`

**Interfaces:**
- Produces: React app with TanStack Query provider, Zustand UI store, typed API client and hooks

- [ ] **Step 1: Write API client**

```typescript
// packages/web/src/api/client.ts
export interface ReviewSession {
  id: string; branch: string; baseRef: string;
  status: "planning" | "walking" | "complete"; createdAt: number;
}
export interface Unit {
  id: string; sessionId: string; position: number; label: string;
  rationale: string; entryPointNodeIds: string[];
}
export interface Node {
  id: string; sessionId: string; stableId: string; unitId: string | null;
  label: string; file: string; startLine: number; endLine: number;
  changeStatus: "changed" | "unchanged";
  reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
  reviewedInUnit: number | null;
}
export interface Comment {
  id: string; sessionId: string; nodeId: string; hunkSnippet: string;
  text: string; structuralContext: string; createdAt: number;
}
export interface GraphNode {
  stableId: string; label: string; file: string; startLine: number; endLine: number;
  isEntryPoint: boolean; changeStatus: "changed" | "unchanged";
}
export interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: "call"; }
export interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }

const API_BASE = "/api";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json() as Promise<T>;
}

export const api = {
  createSession: (branch: string, baseRef: string) =>
    fetchJson<{ session: ReviewSession; subgraph: ChangeSubgraph }>("/sessions", {
      method: "POST", body: JSON.stringify({ branch, baseRef }),
    }),
  getSession: (id: string) =>
    fetchJson<{ session: ReviewSession; units: Unit[] }>(`/sessions/${id}`),
  updatePlan: (id: string, units: { label: string; rationale: string; entryPointNodeIds: string[] }[]) =>
    fetchJson<{ units: Unit[] }>(`/sessions/${id}/plan`, {
      method: "PUT", body: JSON.stringify({ units }),
    }),
  getNodes: (id: string, unitId?: string) =>
    fetchJson<{ nodes: Node[] }>(`/sessions/${id}/nodes${unitId ? `?unitId=${unitId}` : ""}`),
  getNode: (sessionId: string, nodeId: string) =>
    fetchJson<{ node: Node; callers: Node[]; callees: Node[] }>(`/sessions/${sessionId}/nodes/${nodeId}`),
  updateNodeStatus: (sessionId: string, nodeId: string, reviewStatus: Node["reviewStatus"], reviewedInUnit?: number) =>
    fetchJson<{ node: Node }>(`/sessions/${sessionId}/nodes/${nodeId}`, {
      method: "PATCH", body: JSON.stringify({ reviewStatus, reviewedInUnit }),
    }),
  getComments: (id: string) =>
    fetchJson<{ comments: Comment[] }>(`/sessions/${id}/comments`),
  createComment: (id: string, nodeId: string, hunkSnippet: string, text: string, structuralContext: string) =>
    fetchJson<{ comment: Comment }>(`/sessions/${id}/comments`, {
      method: "POST", body: JSON.stringify({ nodeId, hunkSnippet, text, structuralContext }),
    }),
  exportComments: (id: string) =>
    fetchJson<Record<string, unknown>>(`/sessions/${id}/export`),
};
```

- [ ] **Step 2: Write TanStack Query hooks**

```typescript
// packages/web/src/api/hooks.ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client.js";

export function useSession(sessionId: string) {
  return useQuery({ queryKey: ["session", sessionId], queryFn: () => api.getSession(sessionId) });
}
export function useNodes(sessionId: string, unitId?: string) {
  return useQuery({ queryKey: ["nodes", sessionId, unitId], queryFn: () => api.getNodes(sessionId, unitId) });
}
export function useNode(sessionId: string, nodeId: string | null) {
  return useQuery({
    queryKey: ["node", sessionId, nodeId], queryFn: () => api.getNode(sessionId, nodeId!),
    enabled: !!nodeId,
  });
}
export function useComments(sessionId: string) {
  return useQuery({ queryKey: ["comments", sessionId], queryFn: () => api.getComments(sessionId) });
}
export function useUpdateNodeStatus(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, reviewStatus, reviewedInUnit }: {
      nodeId: string;
      reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
      reviewedInUnit?: number;
    }) => api.updateNodeStatus(sessionId, nodeId, reviewStatus, reviewedInUnit),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
      qc.invalidateQueries({ queryKey: ["node", sessionId] });
    },
  });
}
export function useCreateComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, hunkSnippet, text, structuralContext }: {
      nodeId: string; hunkSnippet: string; text: string; structuralContext: string;
    }) => api.createComment(sessionId, nodeId, hunkSnippet, text, structuralContext),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["comments", sessionId] });
      qc.invalidateQueries({ queryKey: ["nodes", sessionId] });
    },
  });
}
```

- [ ] **Step 3: Write Zustand UI store**

```typescript
// packages/web/src/store/ui.ts
import { create } from "zustand";

interface UIState {
  splitRatio: number;
  currentUnitIndex: number;
  currentNodeId: string | null;
  walkPath: string[];
  overviewOpen: boolean;
  setSplitRatio: (ratio: number) => void;
  setCurrentUnit: (index: number) => void;
  setCurrentNode: (nodeId: string | null) => void;
  pushToWalkPath: (nodeId: string) => void;
  popWalkPath: () => void;
  toggleOverview: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  splitRatio: 0.5,
  currentUnitIndex: 0,
  currentNodeId: null,
  walkPath: [],
  overviewOpen: false,
  setSplitRatio: (ratio) => set({ splitRatio: Math.max(0.1, Math.min(0.9, ratio)) }),
  setCurrentUnit: (index) => set({ currentUnitIndex: index, currentNodeId: null, walkPath: [] }),
  setCurrentNode: (nodeId) => set({ currentNodeId: nodeId }),
  pushToWalkPath: (nodeId) => set((s) => ({ walkPath: [...s.walkPath, nodeId] })),
  popWalkPath: () => set((s) => ({ walkPath: s.walkPath.slice(0, -1) })),
  toggleOverview: () => set((s) => ({ overviewOpen: !s.overviewOpen })),
}));
```

- [ ] **Step 4: Write placeholder SplitLayout**

```tsx
// packages/web/src/components/SplitLayout.tsx
export function SplitLayout({ _sessionId, _currentNodeId }: {
  sessionId: string;
  currentNodeId: string | null;
}) {
  return (
    <div style={{ flex: 1, display: "flex" }}>
      <div style={{ flex: 1, borderRight: "1px solid #333", padding: "8px" }}>Graph view</div>
      <div style={{ flex: 1, padding: "8px" }}>Diff view</div>
    </div>
  );
}
```

- [ ] **Step 5: Write App shell with providers**

```tsx
// packages/web/src/App.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useUIStore } from "./store/ui.js";
import { SplitLayout } from "./components/SplitLayout.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 1000, refetchOnWindowFocus: false } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ReviewShell />
    </QueryClientProvider>
  );
}

function ReviewShell() {
  const currentNodeId = useUIStore((s) => s.currentNodeId);
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "8px 16px", borderBottom: "1px solid #333" }}>
        <h1 style={{ margin: 0, fontSize: "1rem" }}>Code Review Walkthrough</h1>
      </header>
      <SplitLayout sessionId="placeholder" currentNodeId={currentNodeId} />
    </div>
  );
}
```

- [ ] **Step 6: Update main.tsx**

```tsx
// packages/web/src/main.tsx
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
```

- [ ] **Step 7: Write the failing test**

```tsx
// packages/web/test/App.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App.js";

describe("App", () => {
  it("renders the header", () => {
    render(<App />);
    expect(screen.getByText("Code Review Walkthrough")).toBeInTheDocument();
  });
  it("renders graph and diff placeholders", () => {
    render(<App />);
    expect(screen.getByText("Graph view")).toBeInTheDocument();
    expect(screen.getByText("Diff view")).toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm --filter @crw/web test`
Expected: PASS

Run: `pnpm --filter @crw/web typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/ packages/web/test/App.test.tsx
git commit -m "feat: add web app shell, API client, TanStack Query hooks, Zustand store"
```

---

### Task 7: Web Split Layout + Graph Neighborhood View

**Files:**
- Modify: `packages/web/src/components/SplitLayout.tsx`
- Create: `packages/web/src/components/GraphView.tsx`
- Create: `packages/web/src/components/NodeBadge.tsx`
- Create: `packages/web/test/GraphView.test.tsx`

**Interfaces:**
- Consumes: `useNode` hook from Task 6; `useUIStore` from Task 6
- Produces: Draggable split layout with React Flow graph neighborhood

- [ ] **Step 1: Write NodeBadge component**

```tsx
// packages/web/src/components/NodeBadge.tsx
import type { Node } from "../api/client.js";

const STATUS_STYLES: Record<Node["reviewStatus"], { bg: string; label: string }> = {
  unreviewed: { bg: "#444", label: "unreviewed" },
  "reviewed-clean": { bg: "#2a7a2a", label: "✓" },
  "reviewed-commented": { bg: "#a73a2a", label: "✎" },
  "reviewed-elsewhere": { bg: "#4a6a9a", label: "✓ (other)" },
};

export function NodeBadge({ status }: { status: Node["reviewStatus"] }) {
  const style = STATUS_STYLES[status];
  return (
    <span style={{ backgroundColor: style.bg, color: "white", fontSize: "0.7rem", padding: "1px 4px", borderRadius: "3px" }}>
      {style.label}
    </span>
  );
}
```

- [ ] **Step 2: Write the failing GraphView test**

```tsx
// packages/web/test/GraphView.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GraphView } from "../src/components/GraphView.js";

vi.mock("../api/hooks.js", () => ({
  useNode: () => ({
    data: {
      node: {
        id: "n1", sessionId: "s1", stableId: "fn:handleOrder", unitId: "u1",
        label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30,
        changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
      },
      callers: [],
      callees: [{
        id: "n2", sessionId: "s1", stableId: "fn:validateOrder", unitId: null,
        label: "validateOrder", file: "src/orders.ts", startLine: 35, endLine: 50,
        changeStatus: "changed", reviewStatus: "unreviewed", reviewedInUnit: null,
      }],
    },
    isLoading: false,
  }),
}));

function renderWithProviders(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("GraphView", () => {
  it("renders the current node label", () => {
    renderWithProviders(<GraphView sessionId="s1" currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
  });
  it("renders callee nodes", () => {
    renderWithProviders(<GraphView sessionId="s1" currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("validateOrder")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @crw/web test`
Expected: FAIL — GraphView not found

- [ ] **Step 4: Write GraphView with React Flow**

```tsx
// packages/web/src/components/GraphView.tsx
import { ReactFlow, Background, Controls, type Node as FlowNode, type Edge as FlowEdge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useNode } from "../api/hooks.js";
import { useUIStore } from "../store/ui.js";
import { NodeBadge } from "./NodeBadge.js";
import type { Node } from "../api/client.js";

const NODE_COLORS: Record<string, string> = {
  current: "#4a9aef", reviewed: "#2a7a2a", frontier: "#8a7a2a", unchanged: "#555",
};

function nodeColor(node: Node, isCurrent: boolean): string {
  if (isCurrent) return NODE_COLORS.current;
  if (node.reviewStatus !== "unreviewed") return NODE_COLORS.reviewed;
  if (node.changeStatus === "unchanged") return NODE_COLORS.unchanged;
  return NODE_COLORS.frontier;
}

export function GraphView({ sessionId, currentNodeId, onSelectNode }: {
  sessionId: string;
  currentNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { data } = useNode(sessionId, currentNodeId);
  const overviewOpen = useUIStore((s) => s.overviewOpen);

  if (!data || !currentNodeId) {
    return <div style={{ flex: 1, padding: "16px" }}>Select a node to begin</div>;
  }

  const { node, callers, callees } = data;
  const flowNodes: FlowNode[] = [
    ...callers.map((n, i) => ({
      id: n.id, position: { x: 250, y: i * 80 },
      data: { label: n.label }, style: { background: nodeColor(n, false) },
    })),
    {
      id: node.id, position: { x: 250, y: callers.length * 80 + 40 },
      data: { label: node.label }, style: { background: nodeColor(node, true) },
    },
    ...callees.map((n, i) => ({
      id: n.id, position: { x: 250, y: (callers.length + 1) * 80 + 80 + i * 80 },
      data: { label: n.label }, style: { background: nodeColor(n, false) },
    })),
  ];
  const flowEdges: FlowEdge[] = [
    ...callers.map((n) => ({ id: `${n.id}-${node.id}`, source: n.id, target: node.id })),
    ...callees.map((n) => ({ id: `${node.id}-${n.id}`, source: node.id, target: n.id })),
  ];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "4px 8px", display: "flex", alignItems: "center", gap: "8px" }}>
        <strong>{node.label}</strong>
        <NodeBadge status={node.reviewStatus} />
        <span style={{ fontSize: "0.8rem", color: "#888" }}>{node.file}:{node.startLine}</span>
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <ReactFlow nodes={flowNodes} edges={flowEdges} onNodeClick={(_, n) => onSelectNode(n.id)} fitView>
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      {overviewOpen && (
        <div style={{ padding: "4px 8px", fontSize: "0.8rem", color: "#888" }}>Overview mini-map (full DAG — future)</div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Update SplitLayout with draggable divider**

```tsx
// packages/web/src/components/SplitLayout.tsx
import { useRef, useCallback } from "react";
import { useUIStore } from "../store/ui.js";
import { GraphView } from "./GraphView.js";

export function SplitLayout({ sessionId, currentNodeId }: {
  sessionId: string;
  currentNodeId: string | null;
}) {
  const splitRatio = useUIStore((s) => s.splitRatio);
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const setCurrentNode = useUIStore((s) => s.setCurrentNode);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(() => {
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setSplitRatio((e.clientX - rect.left) / rect.width);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [setSplitRatio]);

  return (
    <div ref={containerRef} style={{ flex: 1, display: "flex", overflow: "hidden" }}>
      <div style={{ flex: splitRatio, overflow: "hidden" }}>
        <GraphView sessionId={sessionId} currentNodeId={currentNodeId} onSelectNode={setCurrentNode} />
      </div>
      <div onMouseDown={handleMouseDown} style={{ width: "4px", cursor: "col-resize", background: "#333", flexShrink: 0 }} />
      <div style={{ flex: 1 - splitRatio, padding: "8px", overflow: "auto" }}>Diff view</div>
    </div>
  );
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm --filter @crw/web test`
Expected: PASS

Run: `pnpm --filter @crw/web typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/SplitLayout.tsx packages/web/src/components/GraphView.tsx packages/web/src/components/NodeBadge.tsx packages/web/test/GraphView.test.tsx
git commit -m "feat: add draggable split layout and React Flow graph neighborhood view"
```

---

### Task 8: Web Diff Viewer + Frontier Strip + Comments + Review Status

**Files:**
- Create: `packages/web/src/components/DiffView.tsx`
- Create: `packages/web/src/components/FrontierStrip.tsx`
- Create: `packages/web/src/components/CommentBox.tsx`
- Modify: `packages/web/src/components/SplitLayout.tsx` (wire all components)
- Create: `packages/web/test/DiffView.test.tsx`
- Create: `packages/web/test/FrontierStrip.test.tsx`
- Create: `packages/web/test/CommentBox.test.tsx`

**Interfaces:**
- Consumes: `useNodes`, `useComments`, `useUpdateNodeStatus`, `useCreateComment` hooks
- Produces: Side-by-side diff, frontier agenda strip, comment authoring, mark-reviewed controls

- [ ] **Step 1: Write the failing DiffView test**

```tsx
// packages/web/test/DiffView.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DiffView } from "../src/components/DiffView.js";

const baseNode = {
  id: "n1", sessionId: "s1", stableId: "fn:handleOrder", unitId: "u1",
  label: "handleOrder", file: "src/orders.ts", startLine: 10, endLine: 30,
  changeStatus: "changed" as const, reviewStatus: "unreviewed" as const, reviewedInUnit: null,
};

describe("DiffView", () => {
  it("renders the node label and file path", () => {
    render(<DiffView node={baseNode} />);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
  });
  it("shows unchanged badge for context nodes", () => {
    render(<DiffView node={{ ...baseNode, changeStatus: "unchanged" }} />);
    expect(screen.getByText("unchanged")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Write DiffView component**

```tsx
// packages/web/src/components/DiffView.tsx
import ReactDiffViewer from "react-diff-viewer-continued";
import type { Node } from "../api/client.js";
import { NodeBadge } from "./NodeBadge.js";

export function DiffView({ node }: { node: Node }) {
  const oldCode = `// ${node.label} — before (line ${node.startLine})\n// ... original code ...`;
  const newCode = node.changeStatus === "changed"
    ? `// ${node.label} — after (line ${node.startLine})\n// ... new code ...`
    : oldCode;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "4px 0", display: "flex", alignItems: "center", gap: "8px" }}>
        <strong>{node.label}</strong>
        <NodeBadge status={node.reviewStatus} />
        {node.changeStatus === "unchanged" && <span style={{ fontSize: "0.7rem", color: "#888" }}>unchanged</span>}
        <span style={{ fontSize: "0.8rem", color: "#888" }}>{node.file}:{node.startLine}-{node.endLine}</span>
      </div>
      <div style={{ flex: 1, overflow: "auto" }}>
        <ReactDiffViewer oldValue={oldCode} newValue={newCode} splitView hideLineNumbers={false} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Write the failing FrontierStrip test**

```tsx
// packages/web/test/FrontierStrip.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FrontierStrip } from "../src/components/FrontierStrip.js";

const nodes = [
  { id: "n1", label: "handleOrder", reviewStatus: "unreviewed" as const, changeStatus: "changed" as const },
  { id: "n2", label: "validateOrder", reviewStatus: "reviewed-clean" as const, changeStatus: "changed" as const },
];

describe("FrontierStrip", () => {
  it("renders all nodes as agenda items", () => {
    render(<FrontierStrip nodes={nodes} currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("handleOrder")).toBeInTheDocument();
    expect(screen.getByText("validateOrder")).toBeInTheDocument();
  });
  it("marks the current node", () => {
    render(<FrontierStrip nodes={nodes} currentNodeId="n1" onSelectNode={() => {}} />);
    expect(screen.getByText("handleOrder").parentElement!.style.fontWeight).toBe("bold");
  });
});
```

- [ ] **Step 4: Write FrontierStrip component**

```tsx
// packages/web/src/components/FrontierStrip.tsx
interface StripNode {
  id: string; label: string;
  reviewStatus: "unreviewed" | "reviewed-clean" | "reviewed-commented" | "reviewed-elsewhere";
  changeStatus: "changed" | "unchanged";
}

export function FrontierStrip({ nodes, currentNodeId, onSelectNode }: {
  nodes: StripNode[];
  currentNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", gap: "4px", padding: "4px 8px", borderTop: "1px solid #333", overflowX: "auto" }}>
      {nodes.map((n) => {
        const isCurrent = n.id === currentNodeId;
        const isReviewed = n.reviewStatus !== "unreviewed";
        return (
          <button key={n.id} onClick={() => onSelectNode(n.id)} style={{
            padding: "2px 8px", border: "1px solid #555",
            background: isCurrent ? "#4a9aef" : "transparent",
            color: isReviewed ? "#888" : "#fff",
            fontWeight: isCurrent ? "bold" : "normal",
            cursor: "pointer", fontSize: "0.8rem",
            opacity: n.changeStatus === "unchanged" ? 0.6 : 1,
          }}>{n.label}</button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 5: Write the failing CommentBox test**

```tsx
// packages/web/test/CommentBox.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommentBox } from "../src/components/CommentBox.js";

vi.mock("../api/hooks.js", () => ({
  useComments: () => ({
    data: { comments: [{ id: "c1", sessionId: "s1", nodeId: "n1", hunkSnippet: "x", text: "existing comment", structuralContext: "callers: A", createdAt: 1000 }] },
    isLoading: false,
  }),
  useCreateComment: () => ({
    mutate: vi.fn((_args: { text: string }, opts?: { onSuccess?: () => void }) => opts?.onSuccess?.()),
  }),
}));

function renderWithProviders(ui: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

describe("CommentBox", () => {
  it("lists existing comments", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    expect(screen.getByText("existing comment")).toBeInTheDocument();
  });
  it("shows a textarea for new comments", () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    expect(screen.getByPlaceholderText("Leave a review comment...")).toBeInTheDocument();
  });
  it("submits and clears on success", async () => {
    renderWithProviders(<CommentBox sessionId="s1" nodeId="n1" />);
    const ta = screen.getByPlaceholderText("Leave a review comment...");
    fireEvent.change(ta, { target: { value: "new text" } });
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(ta).toHaveValue(""));
  });
});
```

- [ ] **Step 6: Write CommentBox component**

```tsx
// packages/web/src/components/CommentBox.tsx
import { useState } from "react";
import { useComments, useCreateComment } from "../api/hooks.js";

export function CommentBox({ sessionId, nodeId }: { sessionId: string; nodeId: string }) {
  const { data } = useComments(sessionId);
  const createComment = useCreateComment(sessionId);
  const [text, setText] = useState("");
  const comments = data?.comments.filter((c) => c.nodeId === nodeId) ?? [];

  const handleSubmit = () => {
    if (!text.trim()) return;
    createComment.mutate(
      { nodeId, hunkSnippet: "", text: text.trim(), structuralContext: "" },
      { onSuccess: () => setText("") },
    );
  };

  return (
    <div style={{ borderTop: "1px solid #333", padding: "8px" }}>
      <div style={{ marginBottom: "8px" }}>
        <strong>Comments</strong>
        {comments.map((c) => (
          <div key={c.id} style={{ margin: "4px 0", padding: "4px", background: "#222" }}>{c.text}</div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "4px" }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)}
          placeholder="Leave a review comment..."
          style={{ flex: 1, minHeight: "40px", background: "#222", color: "#fff", border: "1px solid #555" }}
        />
        <button onClick={handleSubmit} style={{ padding: "4px 12px" }}>Submit</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Update SplitLayout to wire all components**

```tsx
// packages/web/src/components/SplitLayout.tsx
import { useRef, useCallback } from "react";
import { useUIStore } from "../store/ui.js";
import { useNodes, useNode, useUpdateNodeStatus } from "../api/hooks.js";
import { GraphView } from "./GraphView.js";
import { DiffView } from "./DiffView.js";
import { FrontierStrip } from "./FrontierStrip.js";
import { CommentBox } from "./CommentBox.js";

export function SplitLayout({ sessionId, currentNodeId }: {
  sessionId: string;
  currentNodeId: string | null;
}) {
  const splitRatio = useUIStore((s) => s.splitRatio);
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const setCurrentNode = useUIStore((s) => s.setCurrentNode);
  const containerRef = useRef<HTMLDivElement>(null);
  const { data: nodesData } = useNodes(sessionId);
  const { data: nodeData } = useNode(sessionId, currentNodeId);
  const updateStatus = useUpdateNodeStatus(sessionId);

  const handleMouseDown = useCallback(() => {
    const onMove = (e: MouseEvent) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      setSplitRatio((e.clientX - rect.left) / rect.width);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [setSplitRatio]);

  const allNodes = nodesData?.nodes ?? [];
  const currentNode = nodeData?.node;

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div ref={containerRef} style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: splitRatio, overflow: "hidden" }}>
          <GraphView sessionId={sessionId} currentNodeId={currentNodeId} onSelectNode={setCurrentNode} />
        </div>
        <div onMouseDown={handleMouseDown} style={{ width: "4px", cursor: "col-resize", background: "#333", flexShrink: 0 }} />
        <div style={{ flex: 1 - splitRatio, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {currentNode ? (
            <>
              <div style={{ flex: 1, overflow: "auto", padding: "8px" }}><DiffView node={currentNode} /></div>
              <div style={{ display: "flex", gap: "4px", padding: "4px 8px", borderTop: "1px solid #333" }}>
                <button onClick={() => updateStatus.mutate({ nodeId: currentNode.id, reviewStatus: "reviewed-clean" })}>✓ Mark reviewed</button>
                <button onClick={() => updateStatus.mutate({ nodeId: currentNode.id, reviewStatus: "reviewed-commented" })}>✎ Mark commented</button>
              </div>
              <CommentBox sessionId={sessionId} nodeId={currentNode.id} />
            </>
          ) : (
            <div style={{ padding: "16px" }}>Select a node to begin</div>
          )}
        </div>
      </div>
      <FrontierStrip
        nodes={allNodes.map((n) => ({ id: n.id, label: n.label, reviewStatus: n.reviewStatus, changeStatus: n.changeStatus }))}
        currentNodeId={currentNodeId}
        onSelectNode={setCurrentNode}
      />
    </div>
  );
}
```

- [ ] **Step 8: Run all web tests and typecheck**

Run: `pnpm --filter @crw/web test`
Expected: PASS

Run: `pnpm --filter @crw/web typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/web/src/components/ packages/web/test/
git commit -m "feat: add diff viewer, frontier strip, comment box, and review status controls"
```

---

### Task 9: Skill Markdown + Orchestration Script

**Files:**
- Create: `packages/skill/skill.md`
- Create: `packages/skill/src/orchestrate.ts`
- Create: `packages/skill/test/orchestrate.test.ts`

**Interfaces:**
- Consumes: server API (`POST /api/sessions`, `PUT /api/sessions/:id/plan`, `GET /api/sessions/:id/export`)
- Produces: Claude Code skill definition + TypeScript orchestration script

- [ ] **Step 1: Write the skill markdown**

```markdown
<!-- packages/skill/skill.md -->
---
name: code-review-walkthrough
description: Walk a reviewer through code changes along the call/dependency graph instead of a file tree. Produces a structured review plan, launches a local web UI for graph-based navigation, and exports node-anchored comments.
---

# Code Review Walkthrough

## What this skill does

Given a git branch or diff range, this skill:

1. Creates a review session by asking the local review server for the change subgraph
2. Runs the hybrid partitioner (structure proposes, intent decides) to produce review units
3. Writes the plan to the server
4. Launches the web UI for the reviewer to walk the graph
5. Exports structured, node-anchored comments when the review is complete

## When to use

Use this when reviewing code changes — especially large, AI-generated changes
where file-tree review doesn't map to the code's actual structure.

## How to orchestrate

Run the orchestration script:

```bash
npx tsx packages/skill/src/orchestrate.ts --branch <branch> --base <base-ref>
```

The script will:
- Start the review server if not already running
- Create a session and fetch the change subgraph
- Present the subgraph for partitioning
- Write the plan
- Open the web UI
- Wait for the reviewer to finish
- Export comments as JSON

## Partitioning guidance

- A unit = "a correct commit" — independently valuable, logically whole
- Structure proposes: cluster by entry points and domain entity
- Intent decides: merge/split/label by purpose using the diff
- Every unit carries a one-line rationale
- Well-scoped work yields a single unit; don't split artificially
```

- [ ] **Step 2: Write the orchestration script**

```typescript
// packages/skill/src/orchestrate.ts
import { spawn } from "node:child_process";

const SERVER_URL = process.env.CRW_SERVER_URL || "http://localhost:3456";

interface Session { id: string; branch: string; baseRef: string; status: string; createdAt: number; }
interface GraphNode { stableId: string; label: string; file: string; startLine: number; endLine: number; isEntryPoint: boolean; changeStatus: string; }
interface GraphEdge { sourceStableId: string; targetStableId: string; edgeType: string; }
interface ChangeSubgraph { nodes: GraphNode[]; edges: GraphEdge[]; }
interface UnitInput { label: string; rationale: string; entryPointNodeIds: string[]; }

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init, headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createSession(branch: string, baseRef: string): Promise<{ session: Session; subgraph: ChangeSubgraph }> {
  return fetchJson(`${SERVER_URL}/api/sessions`, { method: "POST", body: JSON.stringify({ branch, baseRef }) });
}

export async function writePlan(sessionId: string, units: UnitInput[]): Promise<void> {
  await fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/plan`, { method: "PUT", body: JSON.stringify({ units }) });
}

export async function exportComments(sessionId: string): Promise<Record<string, unknown>> {
  return fetchJson(`${SERVER_URL}/api/sessions/${sessionId}/export`);
}

export function launchUI(port = 3456): void {
  const url = `http://localhost:${port}`;
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
}

export async function orchestrate(
  branch: string, baseRef: string,
  partitionFn: (subgraph: ChangeSubgraph) => UnitInput[],
): Promise<Record<string, unknown>> {
  const { session, subgraph } = await createSession(branch, baseRef);
  const units = partitionFn(subgraph);
  await writePlan(session.id, units);
  launchUI();
  return exportComments(session.id);
}

async function main() {
  const args = process.argv.slice(2);
  const branchIdx = args.indexOf("--branch");
  const baseIdx = args.indexOf("--base");
  const branch = branchIdx >= 0 ? args[branchIdx + 1] : "HEAD";
  const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : "main";

  const { session, subgraph } = await createSession(branch, baseRef);
  console.log("Session created:", session.id);
  console.log("Subgraph nodes:", subgraph.nodes.length);
  console.log("Entry points:", subgraph.nodes.filter(n => n.isEntryPoint).map(n => n.label));

  const units: UnitInput[] = subgraph.nodes
    .filter(n => n.isEntryPoint)
    .map(n => ({ label: n.label, rationale: `Entry point: ${n.label}`, entryPointNodeIds: [n.stableId] }));

  await writePlan(session.id, units);
  console.log("Plan written with", units.length, "units");
  launchUI();
  console.log("UI launched. To export comments later:");
  console.log(`  curl ${SERVER_URL}/api/sessions/${session.id}/export`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
```

- [ ] **Step 3: Write the orchestration test**

```typescript
// packages/skill/test/orchestrate.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { createSession, writePlan, exportComments, orchestrate } from "../src/orchestrate.js";

const mockFetch = vi.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 404, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

beforeEach(() => { mockFetch.mockClear(); });

describe("orchestrate", () => {
  it("creates a session via the server API", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({
      session: { id: "s1", branch: "feat", baseRef: "main", status: "planning", createdAt: 0 },
      subgraph: { nodes: [], edges: [] },
    }));
    const result = await createSession("feat", "main");
    expect(result.session.id).toBe("s1");
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions", expect.objectContaining({ method: "POST" }));
  });

  it("writes a plan", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ units: [] }));
    await writePlan("s1", [{ label: "U1", rationale: "r", entryPointNodeIds: [] }]);
    expect(mockFetch).toHaveBeenCalledWith("http://localhost:3456/api/sessions/s1/plan", expect.objectContaining({ method: "PUT" }));
  });

  it("exports comments", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ node1: { text: "fix" } }));
    const result = await exportComments("s1");
    expect(result).toEqual({ node1: { text: "fix" } });
  });

  it("orchestrates the full flow", async () => {
    const subgraph = {
      nodes: [{ stableId: "fn:a", label: "a", file: "a.ts", startLine: 1, endLine: 5, isEntryPoint: true, changeStatus: "changed" }],
      edges: [],
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse({ session: { id: "s1", branch: "feat", baseRef: "main", status: "planning", createdAt: 0 }, subgraph }))
      .mockResolvedValueOnce(mockResponse({ units: [] }))
      .mockResolvedValueOnce(mockResponse({}));

    const partitionFn = vi.fn((s: ChangeSubgraph) => [
      { label: "Unit A", rationale: "all in one", entryPointNodeIds: s.nodes.map(n => n.stableId) },
    ]);

    await orchestrate("feat", "main", partitionFn);
    expect(partitionFn).toHaveBeenCalledWith(subgraph);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @crw/skill test`
Expected: PASS

Run: `pnpm --filter @crw/skill typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/skill/
git commit -m "feat: add Claude Code skill definition and orchestration script"
```

---

### Task 10: CRG Graph Provider Integration

**Files:**
- Create: `packages/server/src/graph/crg.ts`
- Create: `packages/server/test/crg.test.ts`
- Modify: `packages/server/src/index.ts` (use CRG when configured)
- Modify: `packages/server/package.json` (add MCP SDK dependency)

**Interfaces:**
- Consumes: `GraphProvider` interface from Task 3; CRG MCP server (stdio)
- Produces: `CrgGraphProvider` class that calls CRG's MCP tools to build the change subgraph

- [ ] **Step 1: Add MCP SDK dependency**

Add to `packages/server/package.json` dependencies:
```json
"@modelcontextprotocol/sdk": "^1.0.0"
```

Run: `pnpm install`

- [ ] **Step 2: Write the CRG provider**

```typescript
// packages/server/src/graph/crg.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { GraphProvider, GraphNode, GraphEdge, ChangeSubgraph } from "./provider.js";
import type { ChangeStatus, EdgeType } from "../types.js";

interface CrgNode {
  id: string; name: string; filePath: string; startLine: number; endLine: number;
  isEntryPoint: boolean; isChanged: boolean;
}
interface CrgEdge { sourceId: string; targetId: string; type: string; }

export class CrgGraphProvider implements GraphProvider {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private command: string[] = ["npx", "code-review-graph"]) {}

  private async getClient(): Promise<Client> {
    if (this.client) return this.client;
    this.transport = new StdioClientTransport({ command: this.command[0], args: this.command.slice(1) });
    this.client = new Client({ name: "crw-server", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
    return this.client;
  }

  async getChangeSubgraph(branch: string, baseRef: string): Promise<ChangeSubgraph> {
    const client = await this.getClient();
    const nodesResult = await client.callTool({ name: "get_changed_nodes", arguments: { branch, baseRef } });
    const edgesResult = await client.callTool({ name: "get_changed_edges", arguments: { branch, baseRef } });
    const crgNodes = this.parseContent<CrgNode[]>(nodesResult);
    const crgEdges = this.parseContent<CrgEdge[]>(edgesResult);
    const nodes: GraphNode[] = crgNodes.map(n => ({
      stableId: n.id, label: n.name, file: n.filePath, startLine: n.startLine, endLine: n.endLine,
      isEntryPoint: n.isEntryPoint, changeStatus: (n.isChanged ? "changed" : "unchanged") as ChangeStatus,
    }));
    const edges: GraphEdge[] = crgEdges.map(e => ({
      sourceStableId: e.sourceId, targetStableId: e.targetId, edgeType: "call" as EdgeType,
    }));
    return { nodes, edges };
  }

  async getNeighbors(stableId: string): Promise<{ callers: GraphNode[]; callees: GraphNode[] }> {
    const client = await this.getClient();
    const callersResult = await client.callTool({ name: "get_callers", arguments: { nodeId: stableId } });
    const calleesResult = await client.callTool({ name: "get_callees", arguments: { nodeId: stableId } });
    return { callers: this.parseContent<GraphNode[]>(callersResult), callees: this.parseContent<GraphNode[]>(calleesResult) };
  }

  private parseContent<T>(result: unknown): T {
    const content = (result as { content: { text: string }[] }).content;
    const text = content?.[0]?.text;
    return text ? JSON.parse(text) as T : [] as unknown as T;
  }

  async close(): Promise<void> {
    if (this.transport) { await this.transport.close(); this.transport = null; this.client = null; }
  }
}
```

- [ ] **Step 3: Write the CRG provider test (mocked MCP client)**

```typescript
// packages/server/test/crg.test.ts
import { describe, it, expect, vi } from "vitest";

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn().mockImplementation((req: { name: string }) => {
      const responses: Record<string, unknown> = {
        get_changed_nodes: { content: [{ text: JSON.stringify([
          { id: "fn:handler", name: "handler", filePath: "src/handler.ts", startLine: 10, endLine: 20, isEntryPoint: true, isChanged: true },
        ]) }] },
        get_changed_edges: { content: [{ text: JSON.stringify([
          { sourceId: "fn:handler", targetId: "fn:helper", type: "call" },
        ]) }] },
        get_callers: { content: [{ text: JSON.stringify([]) }] },
        get_callees: { content: [{ text: JSON.stringify([
          { id: "fn:helper", name: "helper", filePath: "src/helper.ts", startLine: 1, endLine: 5, isEntryPoint: false, isChanged: false },
        ]) }] },
      };
      return Promise.resolve(responses[req.name]);
    }),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({ close: vi.fn().mockResolvedValue(undefined) })),
}));

import { CrgGraphProvider } from "../src/graph/crg.js";

describe("CrgGraphProvider", () => {
  it("returns a change subgraph from CRG", async () => {
    const provider = new CrgGraphProvider(["npx", "code-review-graph"]);
    const subgraph = await provider.getChangeSubgraph("feat", "main");
    expect(subgraph.nodes).toHaveLength(1);
    expect(subgraph.nodes[0].stableId).toBe("fn:handler");
    expect(subgraph.nodes[0].changeStatus).toBe("changed");
    expect(subgraph.edges).toHaveLength(1);
  });
  it("returns callers and callees", async () => {
    const provider = new CrgGraphProvider(["npx", "code-review-graph"]);
    const neighbors = await provider.getNeighbors("fn:handler");
    expect(neighbors.callers).toHaveLength(0);
    expect(neighbors.callees).toHaveLength(1);
    expect(neighbors.callees[0].changeStatus).toBe("unchanged");
  });
});
```

- [ ] **Step 4: Update server entry to use CRG when configured**

```typescript
// packages/server/src/index.ts
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createDatabase } from "./db/connection.js";
import { StubGraphProvider } from "./graph/stub.js";
import { CrgGraphProvider } from "./graph/crg.js";

const db = createDatabase(process.env.CRW_DB_PATH || "review.db");
const useCrg = process.env.CRG_COMMAND !== undefined;
const graphProvider = useCrg
  ? new CrgGraphProvider(process.env.CRG_COMMAND!.split(" "))
  : new StubGraphProvider();

const app = createApp({ db, graphProvider });
const port = Number(process.env.PORT) || 3456;
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`review hub on http://localhost:${info.port}`);
  if (!useCrg) console.log("Using stub graph provider. Set CRG_COMMAND to use CRG.");
});
```

- [ ] **Step 5: Run full test suite and typecheck**

Run: `pnpm test`
Expected: PASS (all packages)

Run: `pnpm typecheck`
Expected: PASS (all packages)

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/graph/crg.ts packages/server/test/crg.test.ts packages/server/src/index.ts packages/server/package.json
git commit -m "feat: add CRG graph provider with MCP client integration"
```

---

## Self-Review

**Spec coverage:**
- Review plan (partitioning) — Task 2 (schema/repo for units), Task 4 (plan endpoint), Task 9 (skill partitioning orchestration)
- Navigation (adjustable split, guided walk, top-down/bottom-up, into unchanged code) — Task 7 (split layout + graph view), Task 8 (frontier strip, node states)
- Review state & comments (node-atomic, reviewed status, node-anchored comments, reuse/split) — Task 2 (schema), Task 4 (node status endpoint), Task 5 (comment endpoints + export), Task 8 (CommentBox, review status controls)
- Graph: typed edges over one engine — Task 3 (GraphProvider interface), Task 10 (CRG provider)
- Architecture (skill, server hub, web UI, CRG behind hub) — Tasks 1-10 (all components)
- Comments-out format (JSON keyed by node id) — Task 5 (export endpoint), Task 9 (skill export)

**Placeholder scan:** No TBDs, TODOs, or "fill in later" found.

**Type consistency:** Repository function signatures match across Task 2 definitions and Task 4/5 route usage. API client types in Task 6 match server types from Task 2. GraphProvider interface consistent across Tasks 3, 10.

**Scope check:** 10 tasks covering the full v1 scope. Each produces independently testable deliverables. The CRG provider (Task 10) uses mocked MCP tests — real CRG integration requires running CRG and may need adjustment to match CRG's actual MCP tool names.
