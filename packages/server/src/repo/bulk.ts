import type { DB } from "../db/connection.js";
import type { Node, ReviewStatus } from "../types.js";
import { getNode, updateNodeReviewStatus } from "./nodes.js";
import { nodeHasComments } from "./comments.js";

export class BulkNodeError extends Error {
  constructor(public missingNodeIds: string[]) {
    super(`nodes not found in session: ${missingNodeIds.join(", ")}`);
    this.name = "BulkNodeError";
  }
}

/**
 * All-or-nothing bulk review-status update. Verifies every node exists and
 * belongs to the session INSIDE the transaction, so a partial failure can
 * never leave a unit half-updated. Preserves the single-PATCH semantics:
 * reviewed-clean normalizes to reviewed-commented when comments exist.
 */
export function bulkUpdateNodeReviewStatus(
  db: DB,
  sessionId: string,
  nodeIds: string[],
  status: ReviewStatus,
  reviewedInUnit?: number,
): Node[] {
  return db.transaction(() => {
    const missing = nodeIds.filter((id) => {
      const n = getNode(db, id);
      return !n || n.sessionId !== sessionId;
    });
    if (missing.length > 0) throw new BulkNodeError(missing);
    for (const id of nodeIds) {
      const effective = status === "reviewed-clean" && nodeHasComments(db, id) ? "reviewed-commented" : status;
      updateNodeReviewStatus(db, id, effective, reviewedInUnit);
    }
    return nodeIds.map((id) => getNode(db, id)!);
  })();
}
