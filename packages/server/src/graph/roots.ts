import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Language-root discovery for the multi-index SCIP provider: one indexer job
 * per project root, detected by marker files. A root nested inside another
 * root of the SAME language is dropped (the outer indexer covers it — e.g.
 * workspace packages under a monorepo root); a different-language root nested
 * inside survives (a Python service inside a TS monorepo).
 *
 * Every language here is enabled by default; callers filter by SCIP_LANGS
 * (see scip.ts).
 */
export type IndexerLanguage = "ts" | "py" | "java" | "cs";

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
  // `*.ext` entries match by suffix (solution/project files carry the project's name).
  cs: ["*.sln", "*.slnx", "*.csproj"],
};

const SOURCE_EXTS: Record<IndexerLanguage, string[]> = {
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  java: [".java"],
  cs: [".cs"],
};

// Fingerprint-only inputs: files the indexers read beyond sources and markers
// (config chains, lockfiles). Not markers — they must not create roots.
const FINGERPRINT_EXTRAS: Record<IndexerLanguage, string[]> = {
  ts: ["tsconfig*.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"],
  py: ["pyrightconfig.json", "setup.cfg", "poetry.lock", "uv.lock", "Pipfile.lock"],
  java: [
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "gradle.lockfile",
    "maven-wrapper.properties",
    "settings.xml",
  ],
  cs: [
    "Directory.Build.props",
    "Directory.Build.targets",
    "Directory.Packages.props",
    "global.json",
    "NuGet.config",
    "packages.lock.json",
  ],
};

/** Marker match: exact file name, or suffix when the marker is a `*.ext` glob. */
function matchesMarker(fileName: string, marker: string): boolean {
  return marker.startsWith("*.") ? fileName.endsWith(marker.slice(1)) : fileName === marker;
}

/**
 * Git pathspecs covering one language's index inputs under a root: its source
 * files, marker files (a tsconfig/pyproject edit changes indexer behavior
 * even when no source file moved), and fingerprint-only extras — config
 * chains (tsconfig `extends`, pyrightconfig/setup.cfg) and lockfiles that
 * alter indexer output but must not create roots. Used to scope the
 * index-cache fingerprint so edits in one language don't invalidate another
 * language's job. In git glob magic a leading `**\/` also matches depth
 * zero, so the repo-root ("") specs cover top-level files.
 */
export function languagePathspecs(language: IndexerLanguage, root: string): string[] {
  const prefix = root ? `${root}/` : "";
  return [
    ...SOURCE_EXTS[language].map((ext) => `:(glob)${prefix}**/*${ext}`),
    ...MARKERS[language].map((m) => `:(glob)${prefix}**/${m}`),
    ...FINGERPRINT_EXTRAS[language].map((m) => `:(glob)${prefix}**/${m}`),
  ];
}

// Never descend into dependency trees, build output, or venvs; hidden dirs
// (".git", ".venv", ".hidden") are skipped by the dot rule.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "coverage", "venv", "__pycache__", "obj"]);

export function discoverLanguageRoots(repoRoot: string): IndexerJob[] {
  const candidates: { language: IndexerLanguage; root: string }[] = [];
  walk(repoRoot, "", candidates);
  const kept = candidates.filter(
    (c) => !candidates.some((o) => o.language === c.language && o.root !== c.root && isInside(c.root, o.root)),
  );
  return kept
    .map((c) => ({ ...c, hasSources: rootHasSources(c.root ? join(repoRoot, c.root) : repoRoot, c.language) }))
    .sort((a, b) =>
      a.root < b.root ? -1 : a.root > b.root ? 1 : a.language < b.language ? -1 : a.language > b.language ? 1 : 0,
    );
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
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);
  for (const language of Object.keys(MARKERS) as IndexerLanguage[]) {
    if (MARKERS[language].some((m) => fileNames.some((f) => matchesMarker(f, m)))) out.push({ language, root: rel });
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
