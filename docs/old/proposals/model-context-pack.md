# Model context-pack — the system-prompt bundle that lets a model zero-shot valid Loom

> **Status:** OPEN (proposal). The **seed** exists — `buildSystemPrompt()` in
> `web/src/agent/system-prompt.ts` ships a one-paragraph Loom brief plus the live
> tool inventory (sourced from the `src/tools/` catalog so it can't drift). That
> is enough for the live BYOK chat to *drive the tools*; it is NOT enough for a
> model to reliably *author* correct Loom from cold. This proposal specifies the
> full pack and — the crux — the **eval harness** that decides when it is good
> enough.
> **Role:** the last mile of M-T8.3 (the AI authoring loop). Consumes the shipped
> agent tools ([`agent-tools-and-mcp.md`](./agent-tools-and-mcp.md)) and the live
> transport; feeds the same `Complete` loop.
> **Depends on:** `loom_list_primitives` / `loom_read_model` (shipped), the
> grammar (`src/language/ddd.langium`), the stdlib doc generator
> (`npm run docs:stdlib`), and the corpus fixtures (`test/fixtures/corpus/`).
> **Scope:** content + an eval, no grammar/IR change.

---

## Problem

The headline promise is *prose → running system*. Today a model in the playground
chat can call `loom_validate` / `loom_generate` / `loom_apply_patch`, but it
authors `.ddd` from a **seed** prompt that names Loom and lists the tools — it
does not know the grammar shapes, the closed page-primitive vocabulary, or the
common-mistake guards. So it validates-then-repairs its way to correctness over
many tool round-trips, or stalls on a class of error it can't self-fix. The
"repair loop covers for a weak prior" path works but is slow and unreliable; the
lever is a **strong prior** — a curated context bundle the model reads once.

The reason this is a *proposal* and not just "write a longer prompt" is the
**definition of done is empirical, not editorial**: the pack is finished when a
frontier model, given only the pack, zero-shots valid systems across a prompt
corpus at a target rate. That needs a measurement harness, and the harness is
half the work.

## Proposed surface

### 1. The pack contents

A compact, budget-bounded bundle (target: a few thousand tokens, not the whole
language reference), assembled from these sections:

- **Grammar cheatsheet** — the declaration skeletons (`system` / `context` /
  `aggregate` / `valueobject` / `enum` / `event` / `ui` / `deployable` /
  `storage` / `resource`), the type forms (`int`/`string`/`bool`/`decimal`,
  `X id`, `T?`, `T[]`, `Money`, enums), and the expression/statement forms a
  domain body uses. Derived from the grammar, not hand-copied (see §2).
- **The closed page-primitive vocabulary** — the exact set `loom_list_primitives`
  returns (layout + sub-primitives), with a one-line use for each, so the model
  never invents a primitive the walker rejects.
- **Common-mistake guards** — the rules that produce the highest-frequency
  diagnostics: cross-aggregate refs use `X id` (never a bare aggregate name); a
  `token` field is non-optional; `STRING` strips its delimiters; a frontend
  deployable needs a `ui:` binding; page bodies only use the closed vocabulary.
  Each guard is a rule the pack states *before* the model errs, mirroring the
  `loom.*` codes that already have fix-hints.
- **Capability + scaffold surface** — the prelude capabilities (`auditable`,
  `softDeletable`, `tenantOwned`, `versioned`, `tenantRegistry`) and the
  `scaffold` macro sugar, so the model reaches for `with crudish` /
  `scaffold(subdomains: […])` instead of hand-rolling CRUD.
- **Worked examples** — a handful of `prose → .ddd → generated-output` triples
  (CLAUDE.md's "two examples per feature" rule at the pack level). The
  deterministic demo's `TASK_TRACKER_DDD` (`web/src/agent/demo.ts`) is one; add a
  multi-aggregate one and a `ui`-heavy one.

### 2. Generated, not hand-maintained

A hand-written pack rots against the grammar. Where feasible each section is
**derived** so it can't drift:

- primitives from `loom_list_primitives` (already the source of truth);
- the intrinsics/collection-op list from the stdlib generator
  (`npm run docs:stdlib`);
- the guard list from the fix-hint-carrying diagnostic codes (`src/language/fix-hints.ts`)
  plus a curated tail;
- examples validated + generated in CI (as `TASK_TRACKER_DDD` already is), so a
  pack example can never be a broken model.

`buildContextPack()` composes these into the string `buildSystemPrompt()` returns
(replacing today's seed), with a token-budget cap and a stable section order.

### 3. The eval harness (the gate)

A headless harness that measures the pack's quality, so "is the pack good enough"
is a number, not a vibe:

- a **prompt corpus** — N plain-English system requests spanning the feature
  surface (single-aggregate CRUD, multi-aggregate with refs, an enum + derived,
  a `ui` with scaffolding, a workflow);
- for each: run one live `Complete` turn (or a fixed number) with ONLY the pack,
  capture the authored `.ddd`, and score it with the real `loom_validate` /
  `loom_generate`;
- report the **zero-shot validity rate** (fraction that validate clean) and the
  **repair-convergence** (turns to green when they don't zero-shot).

The harness runs against a pinned model via the BYOK transport (gated on a key,
like the auth/OIDC e2e suites), so it's opt-in in CI. The **DoD is a target
validity rate** on the corpus — pick it when the harness exists and a baseline is
measured.

## Build plan

1. `buildContextPack()` — assemble the sections above (generated where possible),
   token-budgeted; swap it in for the seed in `buildSystemPrompt()`.
2. The prompt corpus + scorer (headless, injected transport like
   `agent-transport.test.ts`, real `callTool` for scoring).
3. Measure a baseline; iterate the pack against the score; pin the DoD rate.
4. (Optional) per-model tuning — the pack is one string, but a small
   provider-keyed addendum can absorb model-specific quirks.

## Open questions

- **Static vs generated split** — how much of the pack is worth generating vs a
  curated hand-written spine? Generation kills drift but the *selection* of what
  to include is editorial.
- **Token budget** — the whole language reference is too big; what's the minimal
  set that moves the score most? The harness answers this empirically (ablate a
  section, re-measure).
- **Where the corpus lives** — reuse `test/fixtures/corpus/` prompts, or a new
  prose-first corpus? The corpus fixtures are `.ddd`-first; the pack eval is
  prose-first, so likely a new small corpus.
- **CI cost** — the eval needs a real model + key. Nightly / label-gated, like
  the OIDC e2e legs.

## Related

- [`ai-authoring-loop.md`](./ai-authoring-loop.md) — the loop the pack strengthens.
- [`ai-generation-platform.md`](./ai-generation-platform.md) §6 — the strategic
  framing (prose → multi-backend generate → conformance green).
- [`agent-tools-and-mcp.md`](./agent-tools-and-mcp.md) — the tools the pack tells
  the model to drive.
- Live mission: [`docs/new-plan/T8-dx-tooling-ai.md`](../../new-plan/T8-dx-tooling-ai.md) M-T8.3.
