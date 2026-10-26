import { gitHeadSha, repoFingerprint } from "./diff.js";

export type StaleReason = "head-moved" | "working-tree-changed";

/**
 * Stale = a recorded snapshot no longer matches the working tree, either
 * because HEAD moved or a tracked/untracked file changed content (the
 * fingerprint catches edits that leave HEAD untouched). Empty when git (or
 * the recorded state) is unavailable — degrade silently.
 */
export function staleness(
  root: string,
  headSha: string,
  fingerprint: string,
): { stale?: boolean; staleReason?: StaleReason } {
  const currentHead = gitHeadSha(root);
  if (!currentHead || !headSha) return {};
  if (currentHead !== headSha) return { stale: true, staleReason: "head-moved" };
  const currentFp = repoFingerprint(root);
  if (!currentFp || !fingerprint) return {};
  return currentFp === fingerprint ? { stale: false } : { stale: true, staleReason: "working-tree-changed" };
}

/** The working-tree state a stored record is compared against later. */
export function snapshot(root: string): { headSha: string; repoFingerprint: string } {
  return { headSha: gitHeadSha(root) ?? "", repoFingerprint: repoFingerprint(root) ?? "" };
}
