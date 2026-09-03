# Wave 1 hand-off — 1e python + macros

*Branch: `claude/wave-1-python-macros` (see setup note below for why this isn't
`claude/wave-1/python-macros`).*

## Setup note — branch name collision

Step 1 of the packet instructions asks for a sub-branch literally named
`claude/wave-1/python-macros`. On this worktree that collides: a local ref
`refs/heads/claude/wave-1` already exists (checked out in a sibling worktree —
refs are shared across worktrees of the same repo), and git refuses to create
`refs/heads/claude/wave-1/python-macros` alongside it (a ref can't be both a
"file" and a "directory" in the refs namespace). The other wave-1 packets hit
the same collision and resolved it by dropping the slash
(`claude/wave-1-dotnet-adapters`, `claude/wave-1-elixir`, `claude/wave-1-node-ts`,
`claude/wave-1-validator-cli` — all pre-existing dash-separated siblings). I
followed the established convention: **`claude/wave-1-python-macros`**, pushed
to `origin`. The coordinator's fold step should treat this as the packet's
branch.

### 1e python + macros — claude/wave-1-python-macros @ d3280af

| row | outcome | proof: test file + assertion that fails when reverted | notes |
|---|---|---|---|
| M-T6.50 (a) dispatch-builder.ts never imports a saga on()-handler's domain-service call | **fixed** | `test/generator/python/python-domainservice-collector-gaps.test.ts` — "M-T6.50 (a)" describe block; reverting the `domainServiceImportLinesForWorkflow(handlerStmts)` splice makes `expect(dispatch).toContain("from app.domain.services.retry import next_attempt")` fail (dispatch.py calls `next_attempt(...)` with the import line entirely absent) | Also confirmed end-to-end: generated `app/dispatch.py` for a saga `on(...)` handler calling a domain service now carries the import; `ruff check --select F821` on the generated tree is clean |
| M-T6.50 (b) own-state assign in an uncorrelated command workflow rendered `self._x` at module level | **fixed** | same test file, "M-T6.50 (b)" describe block; reverting the `SimpleNamespace` seed makes `expect(wf).toContain("self = SimpleNamespace(_total=0)")` fail (the route emits bare `self._total = quote(base)` with no `self` bound anywhere in the module-level `async def`) | Fix: `workflows-builder.ts`'s `workflowRoute` seeds `self = SimpleNamespace(_field=<zero>, …)` (typed zeros via `zeroFor`, exported from `dispatch-builder.ts`) only when the create body actually reads/writes own-state (`usesOwnState`) AND the workflow has no `correlationField` — a correlated workflow's own-state path is untouched (still routes through the persisted saga row in `dispatch-builder.ts`, already correct). **Scope note:** a workflow that IS correlated (`correlationField` set) but whose PRIMARY facade is command-triggered (a "saga starter" reachable via HTTP) still uses `thisName: "self"` unconditionally in `workflowRoute` with no state-row load/persist at all — same root shape, but a materially bigger fix (needs load-or-allocate + persist, mirroring `dispatch-builder.ts`'s saga path). Not in scope for this row (the mission text names "the uncorrelated command shape" specifically); flagging as an adjacent, unverified-severity gap for the coordinator/a future mission. |
| M-T6.50 (c) `collectStmtExprImports` hand-enumerates 10/11 `StmtIR` kinds, missing `variant-match` | **fixed** | same test file, "M-T6.50 (c)" describe block, calling the now-exported `collectStmtExprImports` directly; reverting to the hand-enumerated switch makes the variant-match assertion (`into.has("decimal")` from a money literal nested in an arm/else body) fail, while the 8 ordinary-kind assertions still pass (confirms it's genuinely the missing arm, not a wholesale regression) | Migrated onto the shared `walkStmtExprsDeep` (per the row's instruction), mirroring the file's two other collectors. `variant-match` is latent, not reproduced via `.ddd` — `renderPyStatements` (shared `_stmt/target.ts`) throws if a `variant-match` ever reaches a Python-rendered body (frontend-only, mirrors every other backend), so the only way to observe the collector's own exhaustiveness is the direct unit test. |
| M-T1.15-nonstring-filter-finds-dropped | **already-done-verified** | `test/ir/scaffold-filter-param-unsupported.test.ts` (pre-existing, 7 tests, green on this base) | #2698 (merged, ancestor of this base) already landed the honest gate `loom.scaffold-filter-param-unsupported`: `filterParamKind` (`_body-builders.ts`) renders `string`/`guid`/`datetime`/`int`/`long`/`bool`/`<X> id`; every other declared find-param type (`enum`, `decimal`/`money`, value objects, arrays, optionals) raises the warning instead of silently dropping. Re-verified directly: a probe fixture with `find byStatus(s: Status)`, `find inRange(lo: money, hi: money)`, and `find forCustomer(c: Customer id)` on fresh `main` shows `byStatus`/`inRange` warned and `forCustomer` rendered — exactly "every param type either renders or is gated," no third case. **One stale-prose finding** (not fixed — `src/diagnostics/messages.ts` is outside this packet's fence): the `loom.scaffold-filter-param-unsupported` message text at `src/diagnostics/messages.ts:2301-2315` still says "`bool`/`datetime`/`guid` have no input at all" — false since the wave-1/08-31 landing; confirmed those three now render (probe: `find byActive(a: bool)`/`find byPlacedAt(t: datetime)`/`find byRef(r: guid)` — zero `loom.scaffold-filter-param-unsupported` hits). Handed to packet 1a below. Coordinator confirmed this disposition mid-session and asked me to move effort to the remaining rows. |
| provenanced-bare-read-in-page-body | **handed-off** (not fixed — genuinely spans two out-of-fence layers; see below) | — | |
| M-T1.26 | **fixed for react/svelte/feliz/flutter; explicitly NOT fixed for vue/angular** (partial, documented) | `test/generator/_walker/image-avatar-attr-cross-target.test.ts` (13 assertions across react/svelte/feliz/flutter) + updated `test/generator/react/walker-image-avatar.test.ts` + updated `test/generator/flutter/a11y.test.ts`; reverting `attrArgValue`/`attrExprValue` to the pre-A12 `stringOrRefArgValue`-shaped local reimplementation fails all 13 new assertions plus both pre-existing pinned tests | See "M-T1.26 — what's fixed and what isn't" below for the exact reasoning and the pack-template change vue/angular still need. |
| G2667-D3 (python arm) — coordinator ask, mid-session | **fixed** | `test/generator/python/python-query-projection-join-missing.test.ts` (5 assertions); reverting `query-projections-builder.ts`'s guarded-lookup back to the direct dict index fails 4 of 5 | Matched the dotnet arm's ruling (packet 1b, `#b75ce2c`): LEFT JOIN semantics — source row survives, joined field is `None`, wire-value transform (`iso(...)`, decimal narrowing) sits inside the guard. `ruff check --select E4,E7,E9,F` and `py_compile` both clean on the generated route. |

## M-T1.26 — what's fixed and what isn't

The row's own framing ("route both slots through the A12 machinery…") undersold
the complexity: `Image`/`Avatar`'s pack templates hardcode the attribute NAME
and `=` (` src={{{src}}}` in every `primitive-image.hbs`/`primitive-avatar.hbs`
across all 15 React/Vue/Svelte/Angular packs I checked), unlike `Anchor`'s
`{{{navAttr "to"}}}`, which lets `navAttrFragment` (walker-core.ts) spell the
**whole** fragment including the attribute name. That's the mechanism A12 relies
on to bind Vue's `:to="expr"` / Angular's `[routerLink]='expr'` — spellings that
put something *before* the attribute name itself, which no string returned as
"the value" can retrofit onto a template that already wrote `src=` literally.

I confirmed empirically (via `tsc --noEmit --jsx react-jsx` on a minimal
repro) that the **pre-existing** `` src=`${slug}` `` output — for a route-param
ref, on every JS-family target — fails to even parse as JSX, not just "isn't
idiomatic." The fix:

- **literal** `src`/`alt` — byte-identical everywhere (`nav.expr` from
  `navArgValue`'s literal branch is `JSON.stringify` on every JSX-family
  target, matching the old `stringOrRefArgValue` output for any realistic
  string; Feliz/Flutter's `fsString`/`dartString` differ only in quote
  character and closes a real `$`-escaping gap `dartString` already handles
  and the old `JSON.stringify` path didn't).
- **dynamic, react/svelte** — brace-wrapped (`src=` + `{expr}` = `src={expr}`,
  the exact spelling `renderAttrBinding` uses for those two targets), now
  valid JSX/Svelte.
- **dynamic, feliz/flutter** — the bare expression text: their packs read
  `src`/`alt` as a raw value in their own language, never spliced markup
  (`Feliz`'s `prop.src`-equivalent, `Flutter`'s `Image.network(...)` call), so
  this was already the right shape once the template-literal bug was gone.
- **dynamic, vue/angular — STILL BROKEN.** Both need the pack's hardcoded
  `src=` prefix replaced with a full-fragment splice (`{{{srcAttr}}}`,
  `{{{altAttr}}}`) mirroring `{{{navAttr "to"}}}`, so `navAttrFragment`-style
  logic can pick `:src="expr"` (Vue) / `[src]="expr"` (Angular) — attribute
  spellings that need something *before* "src", not just a different value
  after "=". That's a `designs/**` change (every pack's
  `primitive-image.hbs`/`primitive-avatar.hbs`), entirely outside this
  packet's fence (`src/generator/_walker/primitives/text.ts` only). I did not
  touch it, and `attrArgValue` explicitly declines to special-case Vue/Angular
  further — for those two, a dynamic value renders the bare expression text
  (same class of "silently wrong, not crashing" as the old ref-case output —
  not a regression, just not the fix).

**Exact shape for whoever picks this up** (in-fence for anyone who *can* touch
`_walker/walker-core.ts` + `designs/**`):

1. Add `srcAttr`/`altAttr`-style full-fragment builders (a `navAttrFragment`
   sibling, or a generalized version taking an attribute name) so the same
   `{expr, dynamic, literal?}` shape used for `to:` produces ` src="…"` /
   ` src={expr}` / ` :src="expr"` / ` [src]="expr"` per target.
2. Change every pack's `primitive-image.hbs` / `primitive-avatar.hbs` from
   ` src={{{src}}}` to `{{{srcAttr}}}` (and the `alt` twin), across all ~15
   packs under `designs/`.
3. `text.ts`'s `emitImage`/`emitAvatar` then pass `srcAttr: (name) =>
   srcAttrFragment(ctx, name, navSrc)`-style closures (mirroring `emitAnchor`'s
   `navAttr` field) instead of the raw `src`/`hasSrc` strings — though
   Feliz/Flutter still need the raw expression text alongside (their packs
   read it directly, not through a markup fragment), so both fields likely
   need to coexist, same as `Anchor` carries both `navAttr` and `to`/`hasTo`.

## `provenanced-bare-read-in-page-body` — hand-off (not fixed)

Confirmed reproduced on this base exactly as the ledger describes: a
hand-written page body reading a `provenanced` field bare (`o.total`, not
`o.total.value`) parses/validates with 0 errors and generates
`<Text>{orderById.data.total}</Text>` on React — the wire type for that field
is `z.object({ value: z.number().int(), lineage: … })`, so this is TS2322 under
`tsc --noEmit` (and `[object Object]` at runtime on frameworks that don't
type-check markup). `PROVENANCE_VALUE_FIELD`/`PROVENANCE_LINEAGE_FIELD` are
still referenced in exactly the two places the ledger names —
`src/macros/stdlib/scaffold/_body-builders.ts` (adds `.value`) and
`src/generator/elixir/heex-walker-core.ts` (drops it, HEEx's own parallel
engine) — confirming no fix has landed for hand-written bodies on the shared
JS-family walker.

**Why this is a hand-off, not a fix:** the auto-unwrap the ledger proposes
("one arm in `emitExpr`'s member case") needs to know whether a given
`member` access targets a `provenanced` field. I traced the exact mechanism
that already solves this ambiguity — for the OPPOSITE direction — in
`src/generator/elixir/heex-walker-core.ts`'s `provenancedFieldNames(ctx)`:
it scans `ctx.aggregatesByName` (every aggregate + part field) for
`f.provenanced`, building a flat NAME set (not receiver-type-precise — a
page body's receiver type is documented as unresolved at `walker-core.ts`,
the same limitation this sidesteps), then checks `expr.member ===
PROVENANCE_VALUE_FIELD && provenancedFieldNames(ctx).has(expr.receiver.member)`
to DROP the hop for HEEx's Ecto-struct reads. Critically, the SHARED
`WalkContext` (`_walker/walker-core.ts:641`) already carries the identical
`aggregatesByName: ReadonlyMap<string, AggregateIR>` HEEx's parallel context
does — so the JS-family fix is a small, well-understood addition to
`emitExpr`'s `case "member":` (walker-core.ts, ~line 1706), NOT a new
resolution mechanism:

```ts
// Mirrors heex-walker-core.ts's provenancedFieldNames(ctx), inverted:
// explicit .value/.lineage stays as the author wrote it (render the inner
// member access WITHOUT letting its own auto-hop fire — that would double
// it); every other bare read of a provenanced field gets .value appended.
if (
  (expr.member === PROVENANCE_VALUE_FIELD || expr.member === PROVENANCE_LINEAGE_FIELD) &&
  expr.receiver.kind === "member" &&
  provenancedFieldNames(ctx).has(expr.receiver.member)
) {
  // render expr.receiver's OWN receiver + `.${expr.receiver.member}` directly
  // (bypassing the arm below), then append `.${expr.member}`.
}
if (provenancedFieldNames(ctx).has(expr.member)) {
  // ordinary bare read — recurse + append `.value` (PROVENANCE_VALUE_FIELD)
}
```

This is squarely `src/generator/_walker/walker-core.ts` — out of this
packet's fence (only `primitives/text.ts` is in it), and open PR #2729 is
already editing that file broadly per the packet brief's own warning to stay
out of it. I did not attempt it. `provenancedFieldNames` itself could live in
`walker-core.ts` alongside the new `case "member"` arm, or be factored into a
tiny shared helper both `walker-core.ts` and `heex-walker-core.ts` import (a
DRY opportunity, not required).

**Verification shape for whoever picks this up**: a walker test per target
(the six `walkBody`-consuming frontends) with a hand-written page body reading
a `provenanced` field both bare and via `.value`, asserting the bare read
gains `.value` and the explicit one is untouched (no double hop) — plus the
existing HEEx behavior stays a documented, deliberate exception (its own test
file already covers that half). Mutation-prove by reverting and confirming
the bare-read assertion fails while the explicit-`.value` one still passes
(the double-hop shape a naive fix could introduce).

## Files outside the fence (handed off)

- `src/diagnostics/messages.ts:2301-2315` — stale prose in
  `loom.scaffold-filter-param-unsupported`'s message text (says `bool`/`datetime`/`guid`
  have no filter input; they do, since wave 1 of the 08-31 fleet plan). Packet 1a
  (owns `src/diagnostics/**`) — a one-line text fix, no code-behavior change.
- `src/generator/_walker/walker-core.ts` — the `provenanced-bare-read-in-page-body` fix
  (exact shape above) and the `srcAttr`/`altAttr` full-fragment builder M-T1.26's
  vue/angular half needs.
- `designs/**` (all ~15 React/Vue/Svelte/Angular packs' `primitive-image.hbs` /
  `primitive-avatar.hbs`) — the template-side half of M-T1.26's vue/angular fix
  (replace hardcoded ` src={{{src}}}` with `{{{srcAttr}}}`).
- `src/generator/dotnet/workflow-emit.ts`-equivalent bug, NODE arm — while
  chasing M-T6.50 (b) I confirmed by direct code read that
  `src/platform/hono/v4/workflow-builder.ts`'s `emitWorkflowRoute` (the
  command-route twin of Python's `workflowRoute`) ALSO hardcodes
  `thisName: "this"` inside an `async (httpCtx) => {…}` ARROW function for
  own-state assigns on an uncorrelated workflow — `this` is `undefined` at
  ESM module scope there too, so `this.counter = 1` would throw at runtime.
  Not verified end-to-end (no generated-node-build probe run — time-boxed),
  and outside this packet's fence (`src/platform/hono/**` is packet 1c's).
  Flagging as a same-class candidate for whoever owns that surface.

## Local gates run + results

- `npx tsc -b` — clean after every row.
- `npx vitest run test/generator/python test/macros test/generator/_walker` (+ every
  touched test individually) — all green; the full `_walker` suite (39 files, 552
  tests) passed with the M-T1.26 fix in place.
- `npx biome check <changed files>` (with `--write` to apply formatter-only
  fixes to two new test files) — clean.
- Python compile leg: not the full Docker `LOOM_PYTHON_BUILD=1` corpus run
  (time-boxed) — substituted `ddd generate system` on hand-built fixtures for
  M-T6.50 and G2667-D3 + `ruff check --select E4,E7,E9,F --ignore
  E711,E712,E741` (the project's pinned rule set) + `python3 -m py_compile`
  over the generated `app/` tree for both. Both clean. `mypy` binary is present
  (`/root/.local/bin/mypy` 1.19.1) but the generated project's own deps
  (fastapi/sqlalchemy/pydantic) weren't installed in this environment and a
  `uv sync` was out of the time budget — not run.
- Mutation-proofs: every row above was reverted via file-copy (never `git
  checkout --`), the named test's failing assertion confirmed, then restored
  by copy-back — per row detail in the table.

## Ledger closes (ids)

Not applied — the packet brief says "Do not edit the ledger JSON or track
files." Recommended for the coordinator's reconciliation pass:

- `M-T6.50` — close (all three sub-gaps fixed and tested).
- `M-T1.15-nonstring-filter-finds-dropped` — close as already-done (the
  coordinator already flagged this mid-session; this hand-off is the
  corroborating test evidence).
- `G2667-D3-projection-join-unguarded-index` — narrow `targets` from
  `["dotnet", "node"]` to close the dotnet+python arms (packet 1b + this
  packet); node/java/elixir remain open per the original ledger entry.
- `M-T1.26` (`docs/new-plan/T1-ui-frontend.md`) — do NOT close; rewrite as
  "react/svelte/feliz/flutter fixed, vue/angular need a `designs/**` pack
  template change" per the exact shape above, rather than leaving it fully
  open (most of the value is delivered) or marking it done (two targets are
  still silently wrong).
- `provenanced-bare-read-in-page-body` — leave open; the hand-off note above
  is precise enough to implement without re-deriving the `aggregatesByName`
  discovery.

## Open questions for the coordinator

1. **M-T1.26 vue/angular** — worth a dedicated follow-up mission (touches
   `designs/**` broadly) rather than folding into this row's closure? The
   react/svelte/feliz/flutter fix is real and tested; vue/angular need
   pack-template surgery across ~15 files that's a different shape of work.
2. **Node's own-state-assign-on-uncorrelated-workflow gap** (flagged above,
   `src/platform/hono/v4/workflow-builder.ts`) — not verified end-to-end, but
   the code read is unambiguous (`thisName: "this"` inside an arrow function
   with no bound `this`). Worth a probe by whoever owns that file before it's
   independently rediscovered.
3. **`provenanced-bare-read-in-page-body`** — the shape is fully scoped in
   this hand-off; it's a contained `walker-core.ts` change (~15-20 lines) once
   someone has write access there. Worth prioritizing given #2729 is already
   touching that file this wave — sequencing it into the same PR would avoid
   a second review pass over `emitExpr`'s member case.
