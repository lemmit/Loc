# Generated-code review — 2026-06-30

A read-through of the **generated output** (not the emitters in the abstract) for
every backend and frontend, looking for code that is *clearly out of place* —
real logic bugs, dropped declarations, leaked placeholders — rather than style.
(Companion to the earlier `generated-code-review-2026-06.md`.)

**Method.** Two passes. (1) `generate system examples/showcase.ddd` (all 5
backends + 3 frontend packs), one reviewer per target against the spec + emitter.
(2) A second, deeper pass reviewing **each generated project standalone** — as a
hand-written repo a senior engineer inherited, judged on its own merits — across
`showcase`, `store-showcase`, `banking-system`, `pokemon-world`, `inheritance`,
`event-sourcing`, and `persistence-shapes`.

**Headline.** Five genuine bugs found (four fixed here; one delegated). `.NET`
and `Java` domain output is sound. Most second-pass "findings" were **faithful
translations of the source** (a reviewer with no spec mistakes them for bugs) —
catalogued below so they're not re-reported. One real **systemic** gap (update
wire-validation, all 5 backends) is documented as a dedicated follow-up slice
because fixing it on one backend would break cross-backend OpenAPI parity.

---

## Confirmed bugs

| ID | Area | Status |
|---|---|---|
| BUG-1 | Elixir enum-value renders as string, not atom | delegated (other agent) |
| BUG-2 | Elixir workflow op-call args mis-keyed (`arg0`) | **FIXED** |
| BUG-3 | Walker drops lambda/loop refs in text position | **FIXED** |
| BUG-4 | Phoenix `insert` lacks assoc preload → 500 on create | **FIXED** |
| BUG-5 | Elixir custom-find repo-let op-call → `<op>_unknown` fn | **FIXED** (defense-in-depth; validator-gated in prod) |
| SYS-1 | Update-path lacks wire validators (all 5 backends) | documented — needs a dedicated multi-backend slice |

### 🔴 BUG-1 · Enum comparisons are always-false in Elixir domain code — *delegated*

`src/generator/elixir/render-expr.ts:331` renders an `enum-value` ref as a
**string** (`"passed"`), but `schema-emit.ts:432` emits `Ecto.Enum` columns whose
loaded value is the **atom** `:passed`. So `record.build_state == "passed"` is
always false → `Build.passed()` is permanently false and `Build.promote`'s
`precondition passed()` can never succeed. The fix is context-sensitive
(relational ⇒ atom; document jsonb ⇒ string) and overturns a deliberately-pinned
test (`phoenix-render-expr.test.ts:105`). **Owned by a separate agent** per the
work split; left untouched here.

### 🔴 BUG-2 · Workflow-invoked operation args silently dropped (Elixir) — FIXED

The workflow emitters keyed the op-call params map by **positional atom keys**
(`%{arg0: "default"}`), but the context-facade op function reads them by **real
name as string key** (`Map.get(params, "label")`) — so every workflow-driven
operation received `nil` for all arguments.

- Root cause: `dispatch-emit.ts`, `vanilla/workflow-execution-emit.ts`,
  `domain-service-emit.ts` all built `arg<i>:` fields.
- Fix: a shared `opCallParamFields(argTexts, op)` helper (in
  `workflow-execution-emit.ts`) keyed by the resolved op's real parameter names
  as **string** keys (`%{"label" => "default"}`), mirroring `tests-emit.ts`
  (which was already correct). All three producers resolve the op via `lookupOp`
  / `resolveAggOp`.
- Tests: `vanilla-workflow-body-lowering.test.ts` (new bare-named-param case),
  `domain-service-mutating.test.ts` (updated). Gated by the existing
  `elixir-vanilla-build` fixtures (`vanilla-relational-parts`,
  `vanilla-domain-service-mutating`, `vanilla-multi-context-workflows`).

### 🔴 BUG-3 · Walker drops lambda/loop refs in text position — FIXED

`For { each: Cart.lines, line => Card { line } }` rendered the bare loop ref
`line` (used as the Card title) as `<Title>{/* ref: line */}</Title>` — a blank
card. `renderTextContent` (`_walker/walker-core.ts`) resolved param/state/derived
refs but was **missing the `lambdaParams` lookup** that the markup-child handler
(`emitExpr`) already had — so any lambda/loop-bound ref in **text position**
(Card/Heading/Text/Stat title) degraded to a comment.

- Fix: added the `lambdaParams` resolution to `renderTextContent`, mirroring
  `emitExpr`. Now `{line}` renders.
- Affects every JSX/markup frontend (shared walker core). Test:
  `walker-for.test.ts` (new bare-ref-in-text-position case).

### 🔴 BUG-4 · Phoenix `insert` lacks assoc preload → 500 on create — FIXED

For an aggregate with a containment (`contains pipelines: Pipeline[]` → a
`has_many`), `base_changeset` does `cast_assoc(:pipelines)`, but a create payload
without a `pipelines` key leaves the association `%Ecto.Association.NotLoaded{}`.
The vanilla repository's `insert/1` (unlike `update`/`find`, which preload) never
preloaded, so `serialize` (`Map.from_struct`) handed Jason a `NotLoaded` struct →
**500 on POST create** for any containment aggregate.

- Root cause: `vanilla/repository-emit.ts` — `insert` omitted the read-path
  preload.
- Fix: preload the inserted record's associations on the `{:ok, _}` branch
  (`|> case do {:ok, record} -> {:ok, record |> Repo.preload([...])} …`), reusing
  the same association list the reads use; emitted only when the aggregate has
  associations (no-assoc aggregates stay byte-identical).
- Test: `vanilla-relational-parts.test.ts` (extended). Gated by
  `vanilla-relational-parts.ddd` under `elixir-vanilla-build`.

### 🔴 BUG-5 · Elixir custom-find repo-let op-call → wrong context fn — FIXED

Surfaced while hardening BUG-2. An op-call on a variable bound by a **custom**
find (`let i = Items.byLabel(wanted)` then `i.markFound()`) resolved the
receiver's aggregate to `"Unknown"` — because `aggNameForLocal`
(`lower-workflow.ts`) didn't unwrap the find's declared optional return type
(`Item?`) — and emitted a call to a non-existent `Context.mark_found_unknown/2`.

- In **validated** generation this is unreachable: the IR validator rejects a
  nullable/array custom-find repo-let (`'…' returns a nullable; use getById`), so
  only `getById` (a bare entity) survives. It bit only the **unvalidated**
  codegen path (a unit test). The fix is defense-in-depth, not a shipped defect.
- Fixes: `aggNameForLocal` now unwraps `optional`/`array` to the inner entity;
  and `opCallParamFields` was **hardened** as part of BUG-2 — no args ⇒ `%{}`;
  args with an unresolved op now **throw** (loud) instead of silently re-emitting
  positional `arg<i>` keys (which would resurrect BUG-2). The throw cannot fire
  in validated generation.
- Test: `vanilla-workflow-repo-let.test.ts` (asserts `mark_found_item`, never
  `_unknown`).

### 🟠 SYS-1 · Update-path lacks wire validators (all 5 backends) — documented

`CreateXRequest` DTOs carry the field constraints + mirrorable-invariant
validators (so invalid create → **422** at the wire); the `UpdateXRequest`
counterparts carry **none**, so an invalid update is caught only at the domain
floor (**400**, or a 500 where the domain raises differently). Confirmed
independently on **Hono, .NET, Java, Python** (and the same shape on Elixir).

Example (Hono `engineer.routes.ts`): `CreateEngineerRequest` has
`handle: z.string().min(3).max(32)` + `.refine(handle != email)` + the email
regex; `UpdateEngineerRequest` has bare `z.string()` and no `.refine`.

**Why it is not fixed in this pass:** the request schema is part of the
cross-backend **OpenAPI/error contract** that `conformance-parity` gates. Adding
update validators to one backend changes that backend's spec and **breaks
parity** — the exact divergence we want to avoid. It must land on all 5 backends
together, each through its own validation mechanism (zod `.refine` / FluentValidation /
Bean Validation / Pydantic validators), with a decision on whether update should
surface 422 like create. That is a dedicated parity slice (own PR + heavy gates),
not a review-pass edit. **Recommended as the next slice.**

---

## Minor items (disposition)

These are real observations but not correctness defects; each carries a verdict.

- **Java — `Pattern.compile` inline in invariants / validators — FIXED.**
  `string.matches("…")` regexes recompiled on every create/update. Now hoisted
  into reusable `private static final Pattern MATCHES_PATTERN_<i>` fields across
  all three emitters that render domain regexes — the aggregate class
  (`emit/entity.ts`), the value-object record (`emit/enums-vos.ts`), and the wire
  validator (`emit/validator.ts`) — via `collectJavaRegexLiterals` +
  `buildJavaRegexFields` and a `regexFields` map on `JavaRenderContext`. The
  matches arm falls back to inline `Pattern.compile` when no map is supplied
  (so the leaf-level `render-expr-kinds` test is unchanged). Verified: the
  generated project compiles (`gradle testClasses`), and no inline
  `Pattern.compile(...).matcher(...)` remains in the emitted tree. Test:
  `regex-pattern-hoist.test.ts`.
- **Hono — single-result find re-fetched via `findById` — FIXED.** `byName`
  selected the root row, then threw it away and re-ran `findById(row.id)` (a
  redundant root round-trip on every find-by-field call). Not a trade-off — the
  array/paged branches in the same file already hydrate straight from `rootRows`.
  Now the single-result branch mirrors them (bulk-load children off the row in
  hand → `hydrateRootForFindAllExpr`), dropping the extra query (and the tiny
  race window between the two selects). `repository-find-builder.ts`; baseline
  fixture re-captured; regenerated project `tsc --noEmit`s clean. Test:
  `single-find-hydrate.test.ts`.
- **Python — list finds N+1 on children — OPEN (real, follow-up).** `all()` and
  array finds do `[await self._hydrate(row) for row in rows]`, and `_hydrate`
  runs one child `SELECT … WHERE parent_id == row.id` per row → N+1 (1000 rows ⇒
  ~1001 queries). This is a genuine N+1 (worse than the Hono redundant-fetch),
  but the fix needs a bulk-load path built in the Python repository emitter
  (load children by `parent_id IN (ids)`, group by parent, hydrate from the map
  across ~6 list-emitting sites) — a bounded feature, not a review-pass edit.
  Recommended as a focused follow-up.

---

## Catalogued false positives (faithful to source — do not re-report)

Second-pass reviewers had no spec, so they flagged faithful translations. Each
was verified against `examples/showcase.ddd`:

- **`headline` returns "active"/"archived" for `Private`** (.NET/Java/Python):
  the source `match` else-arm is literally `else => (active ? "active" : "archived")`.
- **`displayLabel` ends in `"x"`** (Hono/Python): source is literally
  `label + " #" + "x"` (literal coverage).
- **`touch()` is dead code**: it's a declared `private operation`.
- **Java `pipelines.size() >= 0` always true**: faithful to the tautological
  source invariant `pipelines.count >= 0` (author's literal-coverage choice).
- **`useParams()` result unused** (console_web ProjectDetail): that page renders
  only literals/state and never references `id` — the call is dead but harmless;
  the walker *does* destructure when the id is used (engineer detail).
- **`Table key={idx}`**: the source explicitly sets `keyExpr: "idx"`.
- **Phoenix `created_at` field + `timestamps()`**: the migration emits both —
  consistent.
- **Python `await session.connection(execution_options={isolation_level})`
  result discarded**: the option is applied to the session's transaction
  connection as a side effect; discarding the return is fine.
- **Hono / Python — `decimal` carried as JS `number` / Python `float`**
  (`Number(row.budget)` / `float(row.budget)`): *documented, intentional* — not a
  bug. `docs/language.md` (§"`money` — precise decimal, distinct from `decimal`")
  defines `decimal` as the lossy JSON-`number` type and `money` as the precise
  one (TS → `decimal.js`, Python → `Decimal`, .NET/Java → `decimal`/`BigDecimal`,
  `string` on the wire). Use `money` for exact values; `decimal` is lossy by
  design. "Fixing" it would regress the documented semantics + wire contract.

---

## Verified sound

`.NET` and `Java` domain layers (operations, workflows, events, views, DTOs, JPA
+ Flyway columns, auth filter/ThreadLocal cleanup, `@Transactional` discipline,
`BigDecimal` for money, enum-as-string) were traced end-to-end with no genuine
defects beyond SYS-1 and the minor items above.
