# Source-map debugging — implementation kickoff (Milestone 1)

**Milestone 1 = the Origin spine (backend-agnostic) + a construct-granular `.loom/sourcemap.json`, proved end-to-end on the Hono backend first, then replicated across the other four.** This is the foundational slice of the committed debugging arc in

> **Not a JS-first effort.** The spine lives in the *shared* lowering/IR layer every backend consumes, and `.loom/sourcemap.json` is language-neutral. The only genuinely JS-specific piece — the Source Map **v3** format — is Phase 5 of the proposal, additive on top of this, and out of scope here. Hono is the *reference* backend for the first bracket purely because it has the fastest verification loop in the repo (`behavioral-e2e.yml` boots the generated Hono backend headless on PGlite as a per-PR gate); it is not privileged because it's JavaScript. Bracketing the other four backends is a small, mechanical repeat once the spine is proven, and it's the closing slice of this milestone — that's what makes `ddd trace` (Phase 2) all-backends rather than JS-first.

[`../proposals/source-map-and-debugging.md`](../proposals/source-map-and-debugging.md) — read that first for the north star, the prior art (v3 / JSR-45 SMAP / `#line`+PDB), the full phase roadmap, and the pinned decisions. This doc scopes the *first shippable milestone* and hands over the concrete anchors from a completed codebase investigation.

The kickoff prompt for the implementing session is at the bottom (§7).

## 1. Why this exists

Loom compiles `.ddd` → five backends + four frontends, and today you cannot trace a line of generated target code back to the `.ddd` that produced it. Two boundaries drop the position: **lowering** (AST→IR) discards `$cstNode`, and **emission** (`src/util/code-builder.ts` `lines(...)`) concatenates anonymous strings. Every debug feature we want — `ddd trace`, native source maps, LSP jump-to-source, DAP breakpoints in `.ddd` — needs one substrate underneath it: an **Origin reference** threaded `.ddd` → IR → output. Milestone 1 builds that substrate and proves it end to end on one backend.

## 2. Scope — do this, not more

**In:**
- **Phase 0 (spine — backend-agnostic).** An `OriginRef` type; an optional `origin?` field on the *structural* IR nodes (context / aggregate / operation / field / page); capture from `$cstNode` during lowering; capture the macro-call origin **before** lowering discards the `OriginToken`. This lives in shared lowering/IR — it serves every backend at once, so build it universally, not scoped to one target.
- **Phase 1 (artifact).** A construct-granular `TracedBuilder` bracket in each backend orchestrator; `src/system/sourcemap.ts` emitting `.loom/sourcemap.json`; a `--sourcemap` CLI flag, **default off**. Sequence it: **bracket Hono first** (fastest verification loop) to validate the spine shape end-to-end, then **replicate the bracket across the other four backends** (.NET, Phoenix, Python, Java) as the closing slice — the bracket is mechanically identical per orchestrator once the spine is proven. Land Hono as its own reviewable PR if it helps, but the milestone isn't done until the map covers all five backends.

**Explicitly out (later milestones — do not build):**
- **Source Map v3 / native `#line`+PDB / JSR-45 SMAP.** The genuinely target-specific debug-info formats are Phase 5–6, additive on top of the generic `.loom/sourcemap.json`. (v3 is the *only* JS-specific piece — do not let it leak into this milestone.)
- `ddd trace`, LSP navigation, DAP.
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

- `node bin/cli.js generate system <f.ddd> -o out --sourcemap` writes `.loom/sourcemap.json` for **every backend deployable** (Hono lands first; the milestone closes when all five are covered), whose regions resolve to **real `.ddd` spans** (and, for scaffolded code, to the macro-call span).
- **Without `--sourcemap`, generated output is byte-identical to today** (diff a full `generate system` before/after).
- `test/system/sourcemap.test.ts` gates: every mapped region resolves to a real source span or a macro/derived chain terminating in one; the mapped span's text corresponds to the construct; a coverage floor (≥ N% of emitted domain files carry ≥ 1 mapping) — asserted across backends, not Hono alone.
- `npm test` green; walker/expr and fixture byte-identical gates untouched.
- A sample `sourcemap.json` in the PR body (or a committed fixture) so reviewers see the shape.

## 6. Working agreement

- **Re-sync fresh `main` first** and before each new slice — this repo has fast-moving `main` (parallel agents land continuously); a stale base is the top source of wasted effort here.
- **Open a draft PR before building** to claim the work (suggested title: `feat(sourcemap): Origin spine + construct-granular .loom/sourcemap.json (Hono)`). Check open drafts first so you don't duplicate.
- Base the work branch on `claude/loom-source-map-debug-hw7bj3` (this doc + the proposal live there, docs-only, rebased on recent `main`) or cherry-pick the two docs onto a fresh branch — either way keep the design in the tree.
- **Execute slice by slice to milestone completion** — don't stop after each slice to ask "continue?". Only pause for a genuinely user-owned fork the docs didn't settle; state your default and take it unless irreversible.
- Keep these docs honest if scope shifts under you.

## 7. Kickoff prompt (paste into the new Fable session)

> You're implementing the first milestone of a committed design. Loom (this repo) compiles a `.ddd` DSL to five backends and four frontends, and today nothing can trace a line of generated code back to the `.ddd` that produced it — the IR drops source positions and emission is anonymous string concatenation. We're building a real debugging story (full arc in `docs/old/proposals/source-map-and-debugging.md`); your job is its foundation: the **Origin spine** plus a construct-granular `.loom/sourcemap.json`. This is a platform-wide capability, not a JS feature — the spine lives in the shared lowering/IR layer and the artifact is language-neutral, so it must land for **all backends**. (The one genuinely JS-specific piece, the Source Map v3 format, is a later phase and explicitly out of scope here — don't build it.)
>
> Start from branch `claude/loom-source-map-debug-hw7bj3` — it carries the proposal and the implementation brief at `docs/old/plans/source-map-debug-kickoff.md`, docs-only and rebased on recent `main`. Read both before touching code: the brief has the exact file anchors from a completed investigation and the pinned design decisions. Trust them, but verify against fresh `main` — it moves fast here, so re-sync before you start and between slices.
>
> Done looks like this: `generate system … --sourcemap` emits a `.loom/sourcemap.json` for every backend deployable, mapping generated file regions back to real `.ddd` spans (and scaffolded code back to its macro-call site), while output with the flag OFF stays byte-identical to today. A round-trip test gates it across backends.
>
> Sequence it to de-risk, not to privilege a target: build the spine once (it's shared, so it serves everyone), then prove the emit-side bracket end-to-end on **Hono first** — it has the fastest verification loop in the repo (the behavioral-e2e gate boots the generated Hono backend headless on PGlite) — and once the shape holds, **replicate the bracket across the other four backends** (.NET, Phoenix, Python, Java), which is a mechanical repeat. The milestone isn't done until the map covers all five.
>
> The constraints that matter, and why: capture positions from `$cstNode` at lowering (reuse the `provSiteFor` pattern) and the macro `OriginToken` before lowering discards it, because those are the only two places the position still exists. Store byte offsets on an `origin?` field on the structural IR nodes, not a side-table. Do **not** rewrite `code-builder.ts` — bracket the per-construct emit in each backend orchestrator, which already loops per aggregate/operation. No v3, `ddd trace`, or LSP yet. Don't refactor or tidy beyond what the milestone needs.
>
> Model tiering — this matters, apply it strictly. You (this session) are the orchestrator: keep your own context for planning, the `OriginRef`/macro-chain design, synthesis, and the final adversarial review. Delegate the actual building **down to cheaper models**. On every sub-agent you spawn, set the model **explicitly** — `sonnet` for implementation slices, the four-backend bracket fan-out, file scouting, and test writing; `opus` only for a genuinely hard reasoning slice. **Never spawn a `fable` sub-agent.** Sub-agents inherit your model by default, so an omitted model means an accidental Fable — always pass `model: "sonnet"` (or `"opus"`) on the `Agent` call / `agent()` opts. If you reach for a workflow, set `opts.model` per stage the same way; the orchestration stays with you, the labor goes to Sonnet.
>
> Work autonomously to milestone completion. Open a draft PR first to claim it, then build slice by slice without pausing to ask whether to continue — finishing one slice is the go-ahead for the next. The four-backend bracket replication in particular fans out cleanly across parallel Sonnet sub-agents. Ground every progress claim against a tool result: if a test fails, say so with the output; state what's verified plainly. When you hit a fork the brief didn't settle, name your default and take it unless it's irreversible.
