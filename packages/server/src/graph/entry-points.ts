import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EntryReason = "graph-root" | "exported" | "configured";

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
    const raw = JSON.parse(readFileSync(join(root, ".crw-entry-points.json"), "utf8")) as {
      entryPoints?: unknown;
    };
    if (!Array.isArray(raw.entryPoints)) return [];
    return raw.entryPoints.filter(
      (e): e is ConfiguredEntry =>
        !!e && typeof (e as ConfiguredEntry).label === "string" &&
        ((e as ConfiguredEntry).file === undefined || typeof (e as ConfiguredEntry).file === "string")
    );
  } catch {
    return [];
  }
}

/** Whether the definition line begins with the `export` keyword. */
export function isExportedAt(
  root: string,
  file: string,
  startLine: number,
  cache?: Map<string, string[]>
): boolean {
  try {
    let lines = cache?.get(file);
    if (!lines) {
      lines = readFileSync(join(root, file), "utf8").split("\n");
      cache?.set(file, lines);
    }
    return (lines[startLine - 1] ?? "").trimStart().startsWith("export");
  } catch {
    return false;
  }
}

/**
 * Deterministic confidence: explicit configuration is trusted outright; an
 * exported graph root is probably a real external entry; a bare graph root
 * may just be a utility the index sees no callers for.
 */
export function entryEvidence(flags: {
  isRoot: boolean;
  isExported: boolean;
  isConfigured: boolean;
}): EntryEvidence {
  const reasons: EntryReason[] = [];
  if (flags.isRoot) reasons.push("graph-root");
  if (flags.isExported) reasons.push("exported");
  if (flags.isConfigured) reasons.push("configured");
  const confidence = flags.isConfigured ? 1.0 : flags.isRoot && flags.isExported ? 0.7 : 0.4;
  return { reasons, confidence };
}
