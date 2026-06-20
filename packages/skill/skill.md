<!-- packages/skill/skill.md -->
---
name: code-review-walkthrough
description: Walk a reviewer through code changes along the call/dependency graph instead of a file tree. Produces a structured review plan, launches a local web UI for graph-based navigation, and exports node-anchored comments.
---

# Code Review Walkthrough

## What this skill does

Given a git branch or diff range, this skill:

1. Creates a review session by asking the local review server for the change subgraph
2. Runs the hybrid partitioner (structure proposes, intent decides) to produce review units
3. Writes the plan to the server
4. Launches the web UI for the reviewer to walk the graph
5. Exports structured, node-anchored comments when the review is complete

## When to use

Use this when reviewing code changes — especially large, AI-generated changes
where file-tree review doesn't map to the code's actual structure.

## How to orchestrate

Run the orchestration script:

```bash
npx tsx packages/skill/src/orchestrate.ts --branch <branch> --base <base-ref>
```

The script will:
- Start the review server if not already running
- Create a session and fetch the change subgraph
- Present the subgraph for partitioning
- Write the plan
- Open the web UI
- Wait for the reviewer to finish
- Export comments as JSON

## Partitioning guidance

- A unit = "a correct commit" — independently valuable, logically whole
- Structure proposes: cluster by entry points and domain entity
- Intent decides: merge/split/label by purpose using the diff
- Every unit carries a one-line rationale
- Well-scoped work yields a single unit; don't split artificially
