import { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

/** The statement surface the app uses (matches node:sqlite's StatementSync). */
export interface Statement {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): unknown;
  all(...params: SqlValue[]): unknown[];
}
export type SqlValue = null | number | bigint | string | Uint8Array;

/**
 * The DB seam every repo/route depends on. Backed by node:sqlite —
 * `transaction` and `pragma` are shims for the better-sqlite3 helpers the
 * builtin driver doesn't provide (kept so call sites stay unchanged).
 */
export interface DB {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  pragma(src: string, opts?: { simple?: boolean }): unknown;
  /** Wrap fn in BEGIN/COMMIT (ROLLBACK on throw). Call the returned function to run it. */
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

class NodeSqliteDB implements DB {
  constructor(private db: DatabaseSync) {}
  prepare(sql: string): Statement {
    return this.db.prepare(sql) as unknown as Statement;
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  pragma(src: string, opts?: { simple?: boolean }): unknown {
    const rows = this.db.prepare(`PRAGMA ${src}`).all() as Record<string, unknown>[];
    if (opts?.simple) {
      const first = rows[0];
      return first === undefined ? undefined : Object.values(first)[0];
    }
    return rows;
  }
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec("BEGIN");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    };
  }
  close(): void {
    this.db.close();
  }
}

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `review database schema v${current} is newer than this application (v${SCHEMA_VERSION}); ` +
        `upgrade the app or delete/archive the database file`,
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    const sql = MIGRATIONS[v];
    if (sql === undefined) throw new Error(`missing migration for schema version ${v}`);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v}`);
    })();
  }
}

export function createDatabase(path: string): DB {
  const db = new NodeSqliteDB(new DatabaseSync(path));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function createMemoryDatabase(): DB {
  const db = new NodeSqliteDB(new DatabaseSync(":memory:"));
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** An empty in-memory DB with no migrations applied — for migration tests. */
export function createUnmigratedMemoryDatabase(): DB {
  return new NodeSqliteDB(new DatabaseSync(":memory:"));
}
