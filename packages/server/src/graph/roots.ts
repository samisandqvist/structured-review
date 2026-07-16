import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Language-root discovery for the multi-index SCIP provider: one indexer job
 * per project root, detected by marker files. A root nested inside another
 * root of the SAME language is dropped (the outer indexer covers it — e.g.
 * workspace packages under a monorepo root); a different-language root nested
 * inside survives (a Python service inside a TS monorepo).
 *
 * Java is detected here but only enabled in Phase 4 — callers filter by
 * enabled language (see SCIP_LANGS in scip.ts).
 */
export type IndexerLanguage = "ts" | "py" | "java";

export interface IndexerJob {
  language: IndexerLanguage;
  /** Repo-relative root directory; "" = repo root. */
  root: string;
  /** The root contains at least one source file of its language. */
  hasSources: boolean;
}

const MARKERS: Record<IndexerLanguage, string[]> = {
  ts: ["tsconfig.json", "package.json"],
  py: ["pyproject.toml", "setup.py", "requirements.txt"],
  java: ["pom.xml", "build.gradle", "build.gradle.kts"],
};

const SOURCE_EXTS: Record<IndexerLanguage, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  java: [".java"],
};

// Never descend into dependency trees, build output, or venvs; hidden dirs
// (".git", ".venv", ".hidden") are skipped by the dot rule.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "venv", "__pycache__"]);

export function discoverLanguageRoots(repoRoot: string): IndexerJob[] {
  const candidates: { language: IndexerLanguage; root: string }[] = [];
  walk(repoRoot, "", candidates);
  const kept = candidates.filter(
    (c) => !candidates.some((o) => o.language === c.language && o.root !== c.root && isInside(c.root, o.root))
  );
  return kept
    .map((c) => ({ ...c, hasSources: rootHasSources(c.root ? join(repoRoot, c.root) : repoRoot, c.language) }))
    .sort((a, b) => a.root.localeCompare(b.root) || a.language.localeCompare(b.language));
}

/** True when `child` is strictly inside `parent` ("" = repo root contains everything else). */
function isInside(child: string, parent: string): boolean {
  return parent === "" ? child !== "" : child.startsWith(parent + "/");
}

function walk(abs: string, rel: string, out: { language: IndexerLanguage; root: string }[]): void {
  let entries;
  try {
    entries = readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  const fileNames = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  for (const language of Object.keys(MARKERS) as IndexerLanguage[]) {
    if (MARKERS[language].some((m) => fileNames.has(m))) out.push({ language, root: rel });
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, out);
  }
}

/** Does `absRoot` contain any source file of `language`? (Same skip rules as the walk.) */
export function rootHasSources(absRoot: string, language: IndexerLanguage): boolean {
  const exts = SOURCE_EXTS[language];
  const stack = [absRoot];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && exts.some((x) => e.name.endsWith(x))) return true;
      if (e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name)) stack.push(join(dir, e.name));
    }
  }
  return false;
}
