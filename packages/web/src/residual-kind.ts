import type { ResidualKind } from "./api/client.js";

/** Copy for residual pseudo-nodes: a short badge word plus the tooltip that
 *  explains why the node sits outside the call graph. */
export const RESIDUAL_KIND: Record<ResidualKind, { badge: string; title: string }> = {
  "module-scope": {
    badge: "module",
    title: "Module-level change (imports, types, constants) — not reachable through the call graph",
  },
  "whole-file": {
    badge: "file",
    title: "File has no indexed code — its changes are reviewed outside the call graph",
  },
  deleted: {
    badge: "deleted",
    title: "File was deleted — only removed lines to review",
  },
};
