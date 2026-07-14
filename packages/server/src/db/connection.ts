import Database from "better-sqlite3";
import { SCHEMA_VERSION, MIGRATIONS } from "./schema.js";

export type DB = Database.Database;

export function migrate(db: DB): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `review database schema v${current} is newer than this application (v${SCHEMA_VERSION}); ` +
        `upgrade the app or delete/archive the database file`
    );
  }
  for (let v = current + 1; v <= SCHEMA_VERSION; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v}`);
    })();
  }
}

export function createDatabase(path: string): DB {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function createMemoryDatabase(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
