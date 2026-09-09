import { z } from "zod";
import type { Context } from "hono";

export const sessionCreateSchema = z.object({
  branch: z.string().min(1, "branch is required"),
  baseRef: z.string().min(1, "baseRef is required"),
});

const flowUnitSchema = z.object({
  kind: z.literal("flow"),
  label: z.string().trim(),
  rationale: z.string().optional(),
  flowEntryStableId: z.string().min(1).optional(),
  flowEntryStableIds: z.array(z.string().min(1)).optional(),
});

const orphanUnitSchema = z.object({
  kind: z.literal("orphans"),
  label: z.string().trim(),
  rationale: z.string().optional(),
  orphanStableIds: z.array(z.string().min(1)).optional(),
  // File globs (`**`, `*`, `?`), resolved to orphan stableIds at plan submit.
  orphanFiles: z.array(z.string().min(1)).optional(),
});

export const planSchema = z
  .object({
    overview: z.string().optional(),
    units: z.array(z.discriminatedUnion("kind", [flowUnitSchema, orphanUnitSchema])),
  })
  .superRefine((body, ctx) => {
    const seen = new Set<string>();
    body.units.forEach((u, i) => {
      if (!u.label.trim()) {
        ctx.addIssue({ code: "custom", path: ["units", i, "label"], message: "unit label must be nonempty" });
      }
      // Per-unit dedupe first: the legacy singular entry field may repeat the
      // plural one inside a single unit, which flowEntries() already collapses.
      const ids = u.kind === "flow"
        ? new Set([...(u.flowEntryStableIds ?? []), ...(u.flowEntryStableId ? [u.flowEntryStableId] : [])])
        : new Set(u.orphanStableIds ?? []);
      // An orphan unit may be glob-only: globs resolve to members at submit.
      const globCount = u.kind === "orphans" ? u.orphanFiles?.length ?? 0 : 0;
      if (ids.size === 0 && globCount === 0) {
        ctx.addIssue({
          code: "custom", path: ["units", i],
          message: u.kind === "flow"
            ? "flow unit needs at least one entry stableId"
            : "orphan unit needs at least one member or file glob",
        });
      }
      for (const id of ids) {
        if (seen.has(id)) {
          ctx.addIssue({ code: "custom", path: ["units", i], message: `stableId '${id}' appears in more than one unit` });
        }
        seen.add(id);
      }
    });
  });

export const unitPatchSchema = z
  .object({
    label: z.string().trim().min(1, "label must be nonempty").optional(),
    position: z.number().int().nonnegative().optional(),
  })
  .refine((b) => b.label !== undefined || b.position !== undefined, { message: "nothing to update" });

export const nodePatchSchema = z.object({
  reviewStatus: z.enum(["unreviewed", "reviewed-clean", "reviewed-commented", "reviewed-elsewhere"]),
  reviewedInUnit: z.number().int().nonnegative().optional(),
});

export const bulkNodeStatusSchema = z.object({
  nodeIds: z
    .array(z.string().min(1))
    .min(1, "nodeIds must be nonempty")
    .max(500, "too many nodeIds (max 500)"),
  reviewStatus: z.enum(["unreviewed", "reviewed-clean", "reviewed-commented", "reviewed-elsewhere"]),
  reviewedInUnit: z.number().int().nonnegative().optional(),
});

const anchorSide = z.enum(["old", "new"]);
export const commentAnchorSchema = z.object({
  startLine: z.number().int().positive(),
  startSide: anchorSide,
  endLine: z.number().int().positive(),
  endSide: anchorSide,
});

export const commentCreateSchema = z
  .object({
    // Omitted nodeId = session-wide comment (review body, not inline).
    nodeId: z.string().min(1).optional(),
    text: z.string().trim().min(1, "comment text must be nonempty").max(10_000, "comment too long"),
    anchor: commentAnchorSchema.optional(),
  })
  .refine((b) => !(b.anchor && !b.nodeId), { message: "anchor requires nodeId" });

export const commentPatchSchema = z.object({
  text: z.string().trim().min(1, "comment text must be nonempty").max(10_000, "comment too long"),
});

export type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

/** Parse + validate a JSON body; on failure returns a structured 4xx the
 *  caller returns as-is. Unknown keys are stripped, so older clients that
 *  still send extra fields keep working. */
export async function parseBody<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<Parsed<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, res: c.json({ error: "invalid JSON body" }, 400) };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    return {
      ok: false,
      res: c.json({
        error: "validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      }, 400),
    };
  }
  return { ok: true, data: result.data };
}
