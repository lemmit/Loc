# Source-map debugging — implementation kickoff (Milestone 1)

**Milestone 1 = the Origin spine + a construct-granular `.loom/sourcemap.json` on the Hono/node backend only.** This is the foundational slice of the committed debugging arc in
[`../proposals/source-map-and-debugging.md`](../proposals/source-map-and-debugging.md) — read that first for the north star, the prior art (v3 / JSR-45 SMAP / `#line`+PDB), the full phase roadmap, and the pinned decisions. This doc scopes the *first shippable milestone* and hands over the concrete anchors from a completed codebase investigation.

The kickoff prompt for the implementing session is at the bottom (§7).

## 1. Why this exists

Loom compiles `.ddd` → five backends + four frontends, and today you cannot trace a line of generated target code back to the `.ddd` that produced it. Two boundaries drop the position: **lowering** (AST→IR) discards `$cstNode`, and **emission** (`src/util/code-builder.ts` `lines(...)`) concatenates anonymous strings. Every debug feature we want — `ddd trace`, native source maps, LSP jump-to-source, DAP breakpoints in `.ddd` — needs one substrate underneath it: an **Origin reference** threaded `.ddd` → IR → output. Milestone 1 builds that substrate and proves it end to end on one backend.

## 2. Scope — do this, not more

**In:**
- **Phase 0 (spine).** An `OriginRef` type; an optional `origin?` field on the *structural* IR nodes the Hono path reaches (context / aggregate / operation / field / page as encountered); capture from `$cstNode` during lowering; capture the macro-call origin **before** lowering discards the `OriginToken`.
- **Phase 1 (artifact).** A construct-granular `TracedBuilder` bracket in the Hono orchestrator; `src/system/sourcemap.ts` emitting `.loom/sourcemap.json`; a `--sourcemap` CLI flag, **default off**.

**Explicitly out (later milestones — do not build):**
- Any backend other than Hono/node. One backend proves the shape.
- `ddd trace`, Source Map v3, LSP navigation, DAP.
- Statement- or char-level granularity. Construct-level only.
- Rewriting `code-builder.ts`.

## 3. Key anchors (from the investigation — verify against fresh `main`)

| Concern | Where | Note |
|---|---|---|
| IR node types | `src/ir/types/loom-ir.ts` | Add `OriginRef` + a `Traceable` base with `origin?`. ~3.3k-line union — touch only the structural nodes, not every `ExprIR`. |
| **Existing span capture to reuse** | `provSiteFor` in `src/ir/lower/lower-expr.ts` | Reads `$cstNode.offset` / `.length` for `provenanced` writes today. Same `{path, span}` byte-offset shape — generalize the pattern, don't reinvent it. |
| Prior `{path, span}` artifact | `src/system/loomsnap.ts` (`SnapshotEntry.source`) | Closest existing precedent for a source-side span written into a `.loom/` file. |
| Macro origin (synthetic nodes) | `OriginToken` `{macroName, callNode}` under `ORIGIN_PROP` in `src/macros/api/define.ts` | `callNode` is the `with scaffold(...)` AST node (has a `$cstNode`). **Dropped at lowering today** — capture it into a `MacroRef` before the boundary. |
| Emission primitive | `src/util/code-builder.ts` (`lines` / `indent`) | **Do NOT rewrite.** Anonymous string concat by design. |
| Hono orchestrator (bracket here) | `src/generator/hono/…` → assembled by `src/platform/hono/v5/` | Where the per-aggregate / per-operation content is appended into `Map<path, content>`. Bracket each top-level append: record `(origin, lineStart, lineCount)`. `platform: node` bareword resolves to **v5**. |
| `.loom/` artifact siblings | `src/system/` (`mermaid.ts`, `traceability.ts`, `wire-spec.ts`) | Copy this shape for `sourcemap.ts`; it's derived in phase ⑨ and written in phase ⑩ from `src/cli/main.ts`. |

## 4. Pinned design decisions (proposal §10 — treat as settled)

- **`OriginRef` is a chain:** `source { path, span }` | `macro { macro, call: source }` | `derived { reason }`. Scaffolded nodes → `macro` (points at the `with …` call site); auto-`findAll`/`wireShape` → `derived` ("synthetic", honestly unmapped).
- **Byte offsets in the IR**, not line/col. Line/col is derived only at serialization (a `LineIndex` over the source text).
- **Inline `origin?` on structural nodes**, not a `WeakMap` side-table (identity is fragile across the enrich clone; a field serializes and survives the `Enriched` brand). This is a genuinely non-derivable input, so storing it is correct per the repo's "derive, don't stamp" rule.
- **`--sourcemap` opt-in, default off** — so the byte-identical fixtures and the walker/expr byte-identical gates stay green.

## 5. Definition of done

- `node bin/cli.js generate system <f.ddd> -o out --sourcemap` writes `out/<HonoDeployable>/.loom/sourcemap.json` whose regions resolve to **real `.ddd` spans** (and, for scaffolded code, to the macro-call span).
- **Without `--sourcemap`, generated output is byte-identical to today** (diff a full `generate system` before/after).
- `test/system/sourcemap.test.ts` gates: every mapped region resolves to a real source span or a macro/derived chain terminating in one; the mapped span's text corresponds to the construct; a coverage floor (≥ N% of emitted Hono domain files carry ≥ 1 mapping).
- `npm test` green; walker/expr and fixture byte-identical gates untouched.
- A sample `sourcemap.json` in the PR body (or a committed fixture) so reviewers see the shape.

## 6. Working agreement

- **Re-sync fresh `main` first** and before each new slice — this repo has fast-moving `main` (parallel agents land continuously); a stale base is the top source of wasted effort here.
- **Open a draft PR before building** to claim the work (suggested title: `feat(sourcemap): Origin spine + construct-granular .loom/sourcemap.json (Hono)`). Check open drafts first so you don't duplicate.
- Base the work branch on `claude/loom-source-map-debug-hw7bj3` (this doc + the proposal live there, docs-only, rebased on recent `main`) or cherry-pick the two docs onto a fresh branch — either way keep the design in the tree.
- **Execute slice by slice to milestone completion** — don't stop after each slice to ask "continue?". Only pause for a genuinely user-owned fork the docs didn't settle; state your default and take it unless irreversible.
- Keep these docs honest if scope shifts under you.

## 7. Kickoff prompt (paste into the new Fable session)

> You're implementing the first milestone of a committed design. Loom (this repo) compiles a `.ddd` DSL to several target languages, and today nothing can trace a line of generated code back to the `.ddd` that produced it — the IR drops source positions and emission is anonymous string concatenation. We're building a real debugging story (full arc in `docs/proposals/source-map-and-debugging.md`); your job is its foundation: the **Origin spine** plus a construct-granular `.loom/sourcemap.json`, on the **Hono/node backend only**.
>
> Start from branch `claude/loom-source-map-debug-hw7bj3` — it carries the proposal and the implementation brief at `docs/plans/source-map-debug-kickoff.md`, docs-only and rebased on recent `main`. Read both before touching code: the brief has the exact file anchors from a completed investigation and the pinned design decisions. Trust them, but verify against fresh `main` — it moves fast here, so re-sync before you start and between slices.
>
> Done looks like this: `generate system … --sourcemap` emits a `.loom/sourcemap.json` mapping generated Hono file regions back to real `.ddd` spans (and scaffolded code back to its macro-call site), while output with the flag OFF stays byte-identical to today. A round-trip test gates it.
>
> The constraints that matter, and why: capture positions from `$cstNode` at lowering (reuse the `provSiteFor` pattern) and the macro `OriginToken` before lowering discards it, because those are the only two places the position still exists. Store byte offsets on an `origin?` field on the structural IR nodes, not a side-table. Do **not** rewrite `code-builder.ts` — bracket the per-construct emit in the Hono orchestrator, which already loops per aggregate/operation. One backend only; no `ddd trace`, v3, or LSP yet. Don't refactor or tidy beyond what the milestone needs.
>
> Work autonomously to milestone completion. Open a draft PR first to claim it, then build slice by slice without pausing to ask whether to continue — finishing one slice is the go-ahead for the next. Delegate parallel file-reading to sub-agents where it helps. Ground every progress claim against a tool result: if a test fails, say so with the output; state what's verified plainly. When you hit a fork the brief didn't settle, name your default and take it unless it's irreversible.
