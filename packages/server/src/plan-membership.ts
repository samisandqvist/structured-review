// Plan-submit membership: orphanFiles globs and attachments, in the order that
// keeps tests with their subjects (spec: docs/review-model.md#attachments).
import { countedAttachmentIds, type AttachNode } from "./attach.js";
import type { PlanUnitInput } from "./coverage.js";
import { resolveOrphanFiles } from "./globs.js";
import type { AttachedMember } from "./types.js";

export interface PlanMembership {
  units: PlanUnitInput[];
  attachedPerUnit: AttachedMember[][];
  /** Glob-only units with no member after both passes. */
  emptyUnits: string[];
}

/**
 * Globs claim non-test orphans first; attachment then nests tests under the
 * code they exercise wherever it sits in the plan; a test that attached nowhere
 * is finally placed by the globs after all. A directory glob later in the plan
 * therefore cannot take a test away from the unit holding its subject, and no
 * test loses the unit its path selects. Explicitly listed ids stay explicit.
 */
export function resolvePlanMembership(
  planUnits: PlanUnitInput[],
  orphanNodes: AttachNode[],
  attach: (units: PlanUnitInput[]) => AttachedMember[][],
): PlanMembership {
  const withoutTests = resolveOrphanFiles(
    planUnits,
    orphanNodes.filter((n) => !n.isTest),
  ).units;
  const attachedPerUnit = attach(withoutTests);
  const attachedIds = countedAttachmentIds(attachedPerUnit);
  const unattachedTests = orphanNodes.filter((n) => n.isTest && !attachedIds.has(n.stableId));
  const { units, emptyUnits } = resolveOrphanFiles(withoutTests, unattachedTests);
  return { units, attachedPerUnit, emptyUnits };
}
