# Agent prompt — state auditor

Spawn this as a `general-purpose` (or `Explore`) subagent at the **start** of a
feature, before any design or code. Fill in `{{FEATURE}}` (and the proposal path
if there is one). Its job is to establish ground truth on **fresh `main`** about
what already exists — Loom's `main` moves fast and features are often partially
landed, so this prevents rebuilding shipped work and reasoning from stale code.

---

You are auditing the Loom DSL compiler at `/home/user/Loc` to establish the
current state of the codebase relevant to a proposed language feature, **before**
anyone designs or implements it. Do not modify any files.

**Feature:** {{FEATURE}}
**Proposal (if any):** {{PROPOSAL_PATH}}

First ensure you're reading current code: `git fetch origin main` and confirm the
working tree is at/rebased onto `origin/main` (report if it isn't — a stale base
makes every finding suspect).

Investigate and report:

1. **Is it already shipped or in flight?** Grep the grammar
   (`src/language/ddd.langium`), the validators, the IR types, the emitter arms,
   and the `validate.ts` gates for the feature's keywords/concepts. Check open
   PRs (`mcp__github__list_pull_requests` / `search_pull_requests`, repo
   `lemmit/loc`) and recent `git log --oneline -30`. State plainly: not started /
   partial (which phases/backends done) / shipped. If a proposal doc exists, read
   its status header — but **verify it against the code**, not the prose.

2. **Grammar surface.** Quote the existing `ddd.langium` rules the feature would
   extend or sit next to. Identify whether new syntax is needed or the feature
   reuses existing rules.

3. **The pipeline slice the feature touches.** Walk
   `references/pipeline-checklist.md` and, for each phase the feature plausibly
   reaches, name the *actual current* files and the nearest existing analog
   (e.g. "this is shaped like `criterion` — see `lower-capabilities.ts`,
   `query-checks.ts`, `_expr/target.ts`'s `contains` arm"). Finding the closest
   shipped feature to mirror is the single most useful output.

4. **Backends/frontends in scope.** Given the feature kind (domain-logic expr/stmt
   vs wire-shape vs UI primitive vs persistence-capability vs validate-only),
   list exactly which of the 5 backends + 5 frontends must change, and whether a
   shared seam (`ExprTarget` / `WalkerTarget`) carries it or each target needs
   bespoke work.

5. **Completeness gates it will trip** (print-completeness, walker-stdlib,
   heex-parity, diagnostic-codes, queryable-subset, corpus-coverage) — see
   `references/test-placement.md`.

6. **Risks / unknowns.** Anything that looks harder than the analog: divergent
   backend topology (Phoenix HEEx, event-sourced stores), wire-shape impact,
   migration impact.

Output a dense report (Markdown, < 250 lines): the shipped/partial verdict, the
closest analog to mirror, the concrete file slice by phase, the target matrix,
the gates, and the risks. Real paths only.
