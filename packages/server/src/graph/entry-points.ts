import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EntryReason = "graph-root" | "exported" | "configured" | "http-route" | "tool" | "cli";

export interface EntryEvidence {
  reasons: EntryReason[];
  confidence: number;
}

export interface ConfiguredEntry {
  label: string;
  file?: string;
}

/** Optional explicit entry-point config at the repo root. Malformed or missing → []. */
export function loadConfiguredEntries(root: string): ConfiguredEntry[] {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".srev-entry-points.json"), "utf8")) as {
      entryPoints?: unknown;
    };
    if (!Array.isArray(raw.entryPoints)) return [];
    return raw.entryPoints.filter(
      (e): e is ConfiguredEntry =>
        !!e &&
        typeof (e as ConfiguredEntry).label === "string" &&
        ((e as ConfiguredEntry).file === undefined || typeof (e as ConfiguredEntry).file === "string"),
    );
  } catch {
    return [];
  }
}

/** Whether the definition line begins with the `export` keyword. */
export function isExportedAt(root: string, file: string, startLine: number, cache?: Map<string, string[]>): boolean {
  try {
    let lines = cache?.get(file);
    if (!lines) {
      lines = readFileSync(join(root, file), "utf8").split("\n");
      cache?.set(file, lines);
    }
    return /^export\b/.test((lines[startLine - 1] ?? "").trimStart());
  } catch {
    return false;
  }
}

// Single-line decorator shapes that mark real external entry points.
// Multi-line decorator calls (`@app.route(\n  "/x"\n)`) are not detected — v2
// heuristic, acceptable miss (falls back to graph-root 0.4).
const PY_DECORATOR_REASONS: [RegExp, EntryReason][] = [
  [/^@\w[\w.]*\.(?:route|get|post|put|delete|patch|head|options|websocket)\b/, "http-route"],
  [/^@\w[\w.]*\.(?:tool|resource|prompt)\b/, "tool"],
  [/^@\w[\w.]*\.(?:command|group)\b/, "cli"],
];

/**
 * Detected entry evidence for a Python definition: recognized decorators on
 * the def, or a module-level `if __name__ == "__main__":` block that calls it.
 * scip-python's enclosingRange may start at the def or at its first decorator,
 * so decorators are collected both at/below startLine and directly above it.
 */
export function pythonEntryReasons(
  root: string,
  file: string,
  node: { label: string; startLine: number },
  cache?: Map<string, string[]>,
): EntryReason[] {
  let lines = cache?.get(file);
  if (!lines) {
    try {
      lines = readFileSync(join(root, file), "utf8").split("\n");
    } catch {
      return [];
    }
    cache?.set(file, lines);
  }
  const reasons = new Set<EntryReason>();

  const decoratorAt = (i: number): string | null => {
    const t = (lines![i] ?? "").trim();
    return t.startsWith("@") ? t : null;
  };
  const matchDecorator = (t: string) => {
    for (const [re, reason] of PY_DECORATOR_REASONS) if (re.test(t)) reasons.add(reason);
  };
  // At/below startLine: the span may open on decorator lines; stop at the def.
  for (let i = node.startLine - 1; i < lines.length; i++) {
    const t = decoratorAt(i);
    if (!t) break;
    matchDecorator(t);
  }
  // Directly above startLine: the span may open on the def line instead.
  for (let i = node.startLine - 2; i >= 0; i--) {
    const t = decoratorAt(i);
    if (!t) break;
    matchDecorator(t);
  }

  // `if __name__ == "__main__":` block calling this node -> cli entry.
  const guard = lines.findIndex((l) => /^if\s+__name__\s*==\s*["']__main__["']\s*:/.test(l));
  if (guard !== -1) {
    const callRe = new RegExp(`\\b${node.label}\\s*\\(`);
    for (let i = guard + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l === undefined) break;
      if (l.trim() !== "" && !/^\s/.test(l)) break; // left the indented block
      if (callRe.test(l)) {
        reasons.add("cli");
        break;
      }
    }
  }
  return [...reasons];
}

/** Controller-action attributes (ASP.NET Core MVC attribute routing). */
const CS_ROUTE_ATTRIBUTE = /\[(?:[^\]]*,\s*)?(?:Http(?:Get|Post|Put|Delete|Patch|Head|Options)|Route|AcceptVerbs)\b/;

function cachedLines(root: string, file: string, cache?: Map<string, string[]>): string[] | undefined {
  const hit = cache?.get(file);
  if (hit) return hit;
  try {
    const lines = readFileSync(join(root, file), "utf8").split("\n");
    cache?.set(file, lines);
    return lines;
  } catch {
    return undefined;
  }
}

/**
 * Detected entry evidence for a C# definition: HTTP verb / Route attributes on
 * the lines directly above (or on) the definition line mark a controller
 * action; a `static … Main(` signature marks the program entry.
 */
export function csharpEntryReasons(
  root: string,
  file: string,
  node: { label: string; startLine: number },
  cache?: Map<string, string[]>,
): EntryReason[] {
  const lines = cachedLines(root, file, cache);
  if (!lines) return [];
  const reasons = new Set<EntryReason>();
  const def = lines[node.startLine - 1] ?? "";
  if (/\bstatic\b[^;{=]*\bMain\s*\(/.test(def)) reasons.add("cli");
  if (CS_ROUTE_ATTRIBUTE.test(def)) reasons.add("http-route");
  for (let i = node.startLine - 2; i >= 0; i--) {
    const t = (lines[i] ?? "").trim();
    if (!t.startsWith("[")) break;
    if (CS_ROUTE_ATTRIBUTE.test(t)) reasons.add("http-route");
  }
  return [...reasons];
}

/**
 * Deterministic confidence: explicit configuration is trusted outright;
 * detected framework evidence (route/tool/cli decorators, __main__ guard) is
 * stronger than an exported graph root; a bare graph root may just be a
 * utility the index sees no callers for.
 */
export function entryEvidence(flags: {
  isRoot: boolean;
  isExported: boolean;
  isConfigured: boolean;
  detected?: EntryReason[];
}): EntryEvidence {
  const detected = flags.detected ?? [];
  const reasons: EntryReason[] = [];
  if (flags.isRoot) reasons.push("graph-root");
  if (flags.isExported) reasons.push("exported");
  reasons.push(...detected);
  if (flags.isConfigured) reasons.push("configured");
  const confidence = flags.isConfigured
    ? 1.0
    : detected.length > 0
      ? 0.8
      : flags.isRoot && flags.isExported
        ? 0.7
        : 0.4;
  return { reasons, confidence };
}
