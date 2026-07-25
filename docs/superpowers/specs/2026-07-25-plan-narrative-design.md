# Plan Narrative: Session Overview + Change-Relative Unit Rationales — Design

**Date:** 2026-07-25
**Status:** Approved, awaiting implementation plan

## Problem

CRW's plan answers "what changed and how it connects" but never "what was this
change trying to do, and which slice of that story does this unit carry".
Review units are flow-shaped (entry point → callees), which deliberately
cross-cuts the organization the author described the change in — files,
commits, PR bullet points. The reviewer knows the PR intent; what they don't
know when they land on unit 4 of 7 is which part of that intent this flow
carries. Nobody has written that mapping down anywhere, because nobody but CRW
produced the decomposition.

Unit labels (and the existing optional `rationale`) already help in this
direction; this design completes the layer.

## Principle

The plan gains a narrative layer: one session-level **overview** ("the change
does X, decomposed as…") and per-unit **rationales** rewritten to be
change-relative ("carries part Y of that"). Everything is optional end-to-end
— `crw plan --auto` plans have neither, and nothing else changes behaviour.
All text is authored at plan time by whoever submits the plan (in practice
the review skill); the server stores and serves opaque strings, never
generates.

Descriptions state *relation*, never verdicts ("implements the issuance half
of the token change", not "correctly issues tokens"). This keeps the feature
orientation, not an LLM review that invites rubber-stamping.

## Decisions made during brainstorming

1. **Evolve `rationale`, no new unit field.** Units keep the single existing
   `rationale` column; SKILL.md guidance changes its meaning from "what the
   unit does" to "its role in the overall change". No unit schema change.
2. **Overview reaches UI + export + CLI.** Plan view header, `overview` field
   in the export JSON, printed by `crw status`.
3. **Grounding is intent + observed.** The skill consults stated intent
   (PR description, commit subjects) when available and combines it with what
   it learned authoring the plan. Units that don't serve the stated intent get
   descriptive (not verdict) wording — that is the discrepancy feature.
4. **No rationale backfill for server-created units.** The auto "Unassigned
   changes" unit and submit-time attachments simply have no rationale; the
   overview still frames them. No PATCH endpoint, no second write path.

## Server

### Schema

Migration v9:

```sql
ALTER TABLE review_sessions ADD COLUMN overview TEXT NOT NULL DEFAULT '';
```

### Plan submit

Body becomes `{ overview?, units: [...] }`:

- `overview` — optional string, trimmed; stored on the session.
- Resubmit semantics: the stored overview is **replaced on every submit** —
  an absent (or empty) `overview` field clears it. A replan never leaves a
  stale narrative attached to new units. Units are already wiped and
  recreated on resubmit, so rationales share that lifecycle for free.
- Validation: plain optional string; no server-side length cap (skill
  guidance caps it).

### Read surfaces

- `GET /api/sessions/:id` (and the plan payload the web UI reads) includes
  `overview`.
- `GET /api/sessions/:id/export` gains a top-level `overview` field — empty
  string when unset — so harvest tooling can prepend it to a GitHub PR review
  body. CRW itself never posts anywhere.
- `crw status` prints the overview (first line, truncated) alongside coverage.
- `crw comments` passes the export's `overview` field through unchanged.

No new endpoints, no new tables.

## Skill (the real feature)

SKILL.md's "Building the review plan" section changes in three places:

1. **Before planning — gather stated intent when available.**
   `gh pr view --json title,body` and `git log <base>..<branch> --format=%s`
   (commit subjects only). This is intent input, not diff reading — the
   existing "never run `git diff` for planning" rule stands. If there is no
   PR or the messages are uninformative, proceed observed-only; never block
   on missing intent.
2. **Overview — written after the plan is decided.** 2–4 sentences: what the
   change sets out to do (from stated intent when present, otherwise from
   what the diff observably does), and how the plan decomposes it ("units
   1–2 are the config foundation, units 3–5 the three consumer flows").
   Submitted as the `overview` field in the plan JSON.
3. **Rationale — change-relative.** Guidance changes from "what the unit
   does" to "what part of the overall change this unit carries, in relation
   to the overview" — one or two sentences. When a unit doesn't serve the
   stated intent, the rationale says so descriptively ("not part of the
   stated goal; appears to be a drive-by refactor of the retry helper").
   That wording is the scope-creep signal — there is no separate
   expectation-vs-diff pass and no special comment convention in v1.

## Web UI

Plan view gets an **overview block** above the unit list:

- Rendered in the same visual register as a unit rationale.
- Visually marked as plan-authored narrative (small "from plan" affordance)
  so generated text is never mistaken for tool-derived fact.
- Collapsible — it is orientation, not workflow.
- Absent overview → block not rendered at all (auto plans look exactly like
  today).

Unit rationale rendering is untouched (`PlanView.tsx` already renders
`unit.rationale` under the header).

## Degradation

| Situation | Behaviour |
|---|---|
| `crw plan --auto` | No overview, no rationales; UI shows nothing new |
| Plan resubmitted without `overview` | Stored overview cleared |
| Export with no overview | `overview: ""` |
| No PR / bare commit messages | Skill writes observed-only overview |
| Server-created units (Unassigned changes, attachments) | No rationale; framed by overview only |

## Testing

- Plan submit: overview stored, trimmed; replaced on resubmit; cleared when
  omitted (extend existing plan-submit tests).
- Export: `overview` present, `""` when unset.
- Auto plan: no overview anywhere (assert in existing auto-plan test).
- `crw status`: overview line present when set, absent when not.
- Web: one check that the overview block renders when set and is absent
  otherwise.

## Non-goals

- No server-side text generation of any kind.
- No expectation-vs-diff verdict pass, no `[intent]`-prefixed comments.
- No per-node descriptions.
- No commit-message storage or display (raw messages hold little value —
  reviewers already know them; they are generation *input* only).
- No editing UI for the overview.
- No rationale backfill endpoint for server-created units.

## Sequencing note

Single implementation plan: migration + submit/read surfaces (server), CLI
prints, UI block, SKILL.md rewrite, tests. The plugin bundle must be rebuilt
before pushing runtime changes (committed-bundle rule).
