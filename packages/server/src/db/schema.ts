export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  created_at INTEGER NOT NULL,
  head_sha TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS units (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  label TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'orphans',
  member_stable_ids TEXT NOT NULL DEFAULT '[]',
  auto INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  stable_id TEXT NOT NULL,
  label TEXT NOT NULL,
  file TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  change_status TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  reviewed_in_unit INTEGER,
  is_test INTEGER NOT NULL DEFAULT 0
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
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_node_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_node_id);
CREATE INDEX IF NOT EXISTS idx_comments_session ON comments(session_id);
CREATE INDEX IF NOT EXISTS idx_comments_node ON comments(node_id);
`;

export const SCHEMA_VERSION = 6;
/**
 * SQL applied when upgrading TO each version. Version 1 = baseline tables.
 * `repo_fingerprint` is deliberately NOT in the baseline SCHEMA_SQL: v2 adds it
 * via ALTER TABLE, and fresh DBs run 0→1→2. Keeping the column out of baseline
 * is what lets the same v2 ALTER run cleanly on both fresh and existing DBs.
 */
export const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_SQL,
  2: `ALTER TABLE review_sessions ADD COLUMN repo_fingerprint TEXT NOT NULL DEFAULT '';`,
  3: `ALTER TABLE nodes ADD COLUMN residual_ranges TEXT;`,
  4: `ALTER TABLE comments ADD COLUMN anchor TEXT;`,
  5: `ALTER TABLE review_sessions ADD COLUMN index_warnings TEXT NOT NULL DEFAULT '[]';`,
  6: `ALTER TABLE units ADD COLUMN attached TEXT NOT NULL DEFAULT '[]';`,
};
