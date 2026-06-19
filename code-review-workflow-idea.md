# Code Review Workflow & Tooling — Idea

## Problem
Reviews are now large because AI agents write the code, and commit boundaries rarely map cleanly to reviewable units:

- **Squashed commits** bundle several logical or functional changes into one.
- **Small commits** may contain a bugfix for an earlier commit, or a low-level helper whose correctness can't be judged in isolation without seeing how it is used higher up.


The core frustration: conventional review tools present changes as a **file tree**, and file structure is not the real structure of what the code does. Files and directories don't reflect how the code actually behaves.

## Desired tool
Part Claude Code skill/plugin (the LLM half), part local web UI (meatcheck-style). A "walk me through the code" review experience.

### Flow
1. Given a branch (or generally, or even the whole codebase), first produce a **review plan**: the logical units in which the code is best reviewed.
2. Build a **call/dependency graph** for the unit under review — via an LSP server, an AST builder, or any equivalent — capturing which functions/components use which others.
3. Launch a UI that walks the reviewer through the code along that graph.
4. When review is complete, collect the comments and present the proposed fixes to the user; apply the fixes; then re-review the changes those fixes produced.

### Navigation
- Navigate by **code structure**, not file structure.
- Support both **top-down** and **bottom-up**, switchable on the fly mid-review.
  - Top-down: start from entry points (top-level functions not called from anywhere, triggered externally) and reveal only the components reachable down the call chain.
- Be able to navigate **into unchanged code** to verify that assumptions about the functions being called still hold.
- Mark code **already reviewed in the same pass**, so a function reused by newly added functionality (as it should be) is shown as reviewed and only revisited deliberately.

### Changes & comments
- Show changes as **side-by-side diffs**.
- Per-change **accept** ("this change OK") or **leave a review comment**.
- When reviewing fix-driven changes mid-graph, show **where in the code graph** the changes sit; if they're in the middle of the graph, they appear there.
- All review comments must be **extractable afterwards**, so an agent can be asked to apply the fixes.

### Message-passing / queues
Advantage of the structural approach: for systems with message passing and queues (not plain web software), build the review plan and call graph from **message flow** rather than function calls — i.e. "this component sends this message; these components handle it" — giving a back-and-forth, navigable review even where conventional tools struggle.

## Implementation thoughts
- Possibly an agentic extension to an existing editor (VS Code, Zed, etc.).
- The graph/visualisation could even be done in three.js if nothing better fits.
- Most important idea: make the walkthrough and navigation follow **code structure**, with files explicitly *not* being the thing you look at.

## Prior art & starting points
Web search done. The two halves of this idea exist separately, but nothing combines them; on-the-fly top-down/bottom-up and message-passing/queue call graphs appear genuinely unaddressed. Two pieces together cover most of what's wanted, and the implementing agent should start from these:

- **code-review-graph (CRG)** — Tree-sitter parses functions, classes, imports and call chains into a SQLite-backed graph with blast radius / risk scores, served as an **MCP server to Claude Code / Cursor / Codex** (30 MCP tools). This is the call/dependency-graph engine — get and use it rather than building the graph layer from scratch. https://code-review-graph.com/ · https://github.com/tirth8205/code-review-graph
  - **Implementing agent: install/get CRG and build on it as the graph backend.**
- **claude-reviewer** (Ben Bowles) — local web UI (`serve` on `localhost:3456`) with diffs and inline comments that feed back to Claude to revise. This is the meatcheck-style local-UI + comment→agent-fix loop.
  - **Implementing agent: read this repo for inspiration on the local UI and the comment→fix loop.** https://github.com/bowlesb/claude-reviewer

Other references seen (not the basis, but adjacent): CodeRabbit "cohorts" (dependency-ordered review plan by logical units, + Code Peek for unchanged code); Greptile (repo code graph, multi-hop tracing); Claude Code issue #44787 (proposed official "Code Review Mode" UI, not yet built).

What still has to be built (the novel parts): code-structure graph as the actual review navigation surface, switchable top-down/bottom-up mid-review, marking already-reviewed code within a pass, and message-passing/queue-based call graphs.

## Next steps
1. ~~**Web search first** — is comparable functionality already built somewhere?~~ Done — see Prior art above.
2. Get CRG and read claude-reviewer; then figure out how this should best be built on top of them.
