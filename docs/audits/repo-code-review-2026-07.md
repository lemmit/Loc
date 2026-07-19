# Whole-repo code review — 2026-07-18

Snapshot-in-time review of the entire Loom toolchain, run against `main` at
`6748382`. The repo was swept in nine parallel area passes (language, macros +
lowering, IR enrich/validate/types, TS+.NET backends, Elixir/Python/Java
backends, frontends + body-walker, system/CLI/services, web/vscode/packages,
tests/CI/hooks). Every finding below was read in the actual source; the three
CRITICALs and a sample of the MAJORs were independently re-verified (grep +
generated-output inspection, and in the language/Elixir passes via vitest and
generated fixtures).

This is an audit artifact, not a work order — nothing here is fixed yet. Counts:
**3 CRITICAL, ~33 MAJOR, ~50 MINOR** across ~96 findings.

## Executive summary

The codebase is, on the whole, **well-architected and disciplined**. The
one-directional layering (`language → ir → generator → system`) is real and
mechanically enforced; the shared dispatchers (`ExprTarget`/`renderExprWith`,
the `WalkerTarget` seam, the exhaustive `walk.ts`) have genuinely collapsed
whole classes of drift; SQL surfaces are consistently parameterized and tenant
filters are fail-closed with real e2e gates behind them (no cross-tenant leak
was found on any backend). The error-handling posture (fail-open validators
with `unknown`-suppression, fail-closed semver/discovery gates, path-escape
hardening on the write path) is thoughtful.

The defects concentrate in **four recurring patterns**, and almost every
CRITICAL/MAJOR is an instance of one of them:

1. **Drifting twins of a "single source of truth."** The same logic is
   hand-copied into two places, a comment calls them twins, and nothing pins
   the twinship — so one moves and the other silently lies. The macro-local
   `plural`/`snake` vs `util/naming` (CRITICAL, breaks page classification for
   `Box`/`APIKey`/`Day`…), three copies of `cloneTypeRef`, optional-unwrapping
   present in 2 of 4 member-lookup paths, `extends`-chain walking in 1 of ~6
   member-enumeration sites, and the per-backend import/regex collectors that
   track the dispatcher's recursion by hand.

2. **Derivation/collection walks that lag the lowering surface.** A scan
   shape-matches a fixed set of statement/expression kinds while `lower-expr`
   now emits the interesting node (resource-op, variant-`match` arm, `convert`,
   `list`) somewhere the scan doesn't look. Casualties: `deriveNeeds` skipping
   handler resource-ops (capability gate silently skipped), the C#/Python/Java
   import collectors skipping variant-match arms (non-compiling output),
   `collectIdFollows` missing `convert`/`list`/variant arms (dropped bulk-load).

3. **Valid DSL shapes that no example/fixture exercises, so the compile gates
   never see them.** Optional value-object fields (CRITICAL — broken save AND
   read on Hono), money as the right operand of `*` (MAJOR), a parameterized
   `paged` find on Dapper (MAJOR), money/datetime capability filters on Elixir
   (MAJOR — breaks `mix compile`). Each is a shape-combination hole, not a
   logic error in the common path.

4. **The two newest targets (Flutter, Feliz) inherit JS-shaped assumptions from
   the shared walker core.** Shared-core helpers bake JS syntax into strings
   (`stringOrRefArgValue`'s template literals, raw-text children, JSX-shaped
   `testidAttr`) that the two non-JS targets splice verbatim into Dart/F# — no
   CI compiles either backend's generated output, so these land silently.

The highest-leverage structural fixes: **route every scan through the shared
deep walkers** (kills pattern 2), **consolidate member lookup into one
chain-aware/optional-aware helper** (kills the language pass's findings 1–4),
**add a shape-matrix fixture corpus** (optional VO, commuted money,
parameterized paged find, capability filters with money/datetime — converts
pattern 3 into per-PR failures), and **add `flutter analyze` / Fable build
gates** over generated output (converts pattern 4 into per-PR failures).

---

## CRITICAL findings

### C1 — Optional value-object fields are broken end-to-end on the Hono backend
`src/generator/typescript/repository-save-builder.ts:363-370` &
`repository-find-hydrate.ts:149-150`.
Save side recurses into `${valueExpr}.${vf.name}` with no null guard →
`billing_street: aggregate.billing.street` throws (and fails tsc strict) when
`billing: Address?` is null. Read side guards on `root.billing == null`, but the
row only has flattened `billing_street`/`billing_city` columns, so `root.billing`
is always `undefined` → the VO **always hydrates to null even when data is
present** (silent data loss). No example exercises an optional VO, so
`LOOM_TS_BUILD` never sees it; .NET/Dapper handles it correctly.

### C2 — Scaffolded finds are not aggregate-qualified, so same-named finds collapse into one handler
`src/macros/stdlib/scaffold/_handlers-shared.ts:170` (`targetHandlerName`,
`find` arm returns `upperFirst(t.find.name)` — every other kind folds in the
aggregate name). Two aggregates each declaring `find byStatus(...)` +
`with scaffoldHandlers` both derive handler `ByStatus`; the expander's
scope-local override-by-name silently drops the second `queryHandler` *before*
validation (so `loom.duplicate-handler` never fires), yet `scaffoldApi` still
emits both routes bound to the survivor — **one route serves the wrong
aggregate's data, with zero diagnostics.**

### C3 — Hand-copied `plural`/`snake` in the scaffold macro drift from `util/naming`, breaking page classification
`src/macros/stdlib/scaffold/_pages.ts:248-259` (module-local `plural`:
`y→ies` unconditional, only `s→es`, no `x/z/ch/sh`) vs `src/util/naming.ts:26-28`
(the version `classifyPage` in `page-kind.ts` actually consumes). `Box` → macro
emits `area Boxs` while `classifyPage` expects `boxes`; likewise `Day→Daies` vs
`days`, `APIKey→apikeys` vs `api_keys`. List/New/Detail all misclassify as
`custom`: the Detail page never gets its synthesized `id` route param (generated
page references an undeclared `id`), and the non-constructible-New drop /
list-create-button strip never fire. CLAUDE.md explicitly mandates routing
casing through `util/naming`; the "dedup is a follow-up" comment hides a live
correctness bug.

---

## MAJOR findings by area

### Language (`src/language/`)
- **L1** — `extends`-inherited fields are invisible to expression envs / lvalue
  resolution (`validators/_shared.ts:52-75`, `type-system.ts:1294/851/1311`):
  writing an inherited field in a subtype operation is a hard false positive
  ("Cannot resolve 'title'" on legal code); reading one types as `unknown` and
  silently disables all downstream checks. Verified via vitest.
- **L2** — `checkFactoryCreateFields` ignores the `extends` chain
  (`builder-call.ts:409-415`): `Sub.create({ title: … })` where `title` is a
  base field is falsely rejected as `loom.create-unknown-field`. Verified.
- **L3** — optional receivers are never unwrapped by `typeAfterSuffix`/`stepInto`
  (`type-system.ts:809-849/1311-1343`): `billing.street := s` false-positives,
  and `derived s2: int = billing.street` (string→int) passes with zero
  diagnostics. Completion offers members the checker can't type. Verified.
- **L4** — statement-position `Agg.create({…})` escapes `checkFactoryCreateFields`
  entirely (`builder-call.ts:394-404` matches only `PostfixChain`, not the
  `AssignOrCallStmt` `LValue` form) — the exact gap the gate exists to close is
  a silent false negative in reactor/workflow bodies. Verified.

### Macros + IR lowering (`src/macros/`, `src/ir/lower/`)
- **M1** — `ForStmt`/`IfLetStmt` in operation/create/destroy/function/page-action
  bodies silently lower to a `{ kind: "call", name: "<unknown>" }` no-op
  (`lower-stmt.ts:317-321`; the grammar admits both in every statement position,
  no arm handles them, no validator gates the sentinel). Confirmed: no
  `ForStmt`/`IfLetStmt` reference exists anywhere in `lower-stmt.ts`.
- **M2** — `getById` is pushed before the finds (`_handlers-shared.ts:132-135`),
  so on registration-order routers (Hono, FastAPI, Phoenix) `GET /orders/{id}`
  shadows every `GET /orders/by_status` find → 404/400 from getById.
- **M3** — inlined `criterion`/`policy-fn` bodies are not paren-wrapped
  (`lower-expr.ts:1288/1217`) unlike `inlineTopLevelFn` (`:1335`):
  `filter !Closed` emits `!this.status === "closed"`; `A && B` where B contains
  `||` mis-associates.
- **M4** — `collectIdFollows` misses `convert`/`list`/`match.variantArms`
  (`id-follow.ts:48-90`): `bind label = "Age: " + customerId.age` never plans the
  auxiliary bulk-load → reads a member off the raw id value.

### IR enrich/validate/types (`src/ir/`)
- **I1** — `deriveNeeds` walks only workflow bodies and only two statement shapes
  (`enrichments.ts:300-313`), so a `files.put(...)` in a command/query handler or
  any nested expression derives no `NeedIR` → capability gate silently skipped;
  compounded by `handlerMutates` not counting `resource-call` as a mutation.
- **I2** — Dapper gate false-negative for projection-only contexts
  (`system-checks.ts:1898-1902`): the gate reads the stamped
  `eventSubscriptions` which omits projection folds (I3), so a projection-only
  Dapper context passes validation then emits a dispatcher injecting the EF
  context Dapper doesn't emit → won't compile.
- **I3** — `ctx.eventSubscriptions` is a stamped cache derived *without* the
  `projections` arg (`enrichments.ts:735`); four generators carry compensating
  re-derivations, `mergeContexts` and the validator take the stale union. The
  "derive, don't stamp" anti-pattern the repo warns about, and I2 is its first
  casualty.
- **I4** — inheritance subtype's declared id type is silently overridden by the
  root base's (`enrichments.ts:661-675`) with no validator backstop:
  `Dog extends Animal` with an explicit `ids string` silently emits an `int` id.

### TS + .NET backends
- **T1** — TS money arithmetic breaks when money is the right operand
  (`typescript/render-expr.ts:569`): `qty * total` (int×money, a commutative form
  the type system admits) emits plain `*` → lossy `number`, and the next
  `.plus(...)` throws.
- **T2** — Dapper paged find drops the find's own predicate params from the rows
  query (`dotnet/emit/dapper.ts:842`; the COUNT query at :840 binds them) →
  unbound `@x` Npgsql parameter at runtime.
- **T3** — Dapper `SaveAsync` is not transactional (`dapper.ts:1055-1066`): the
  CAS upsert + join-table/containment DELETE-then-INSERT run autocommit; a crash
  mid-flush permanently loses children. EF and Hono paths are both atomic.
- **T4** — `collectCsExprUsings` skips variant-`match` subject/arm values
  (`dotnet/render-expr.ts:190-196`): a `matches(...)`/domain-service call inside a
  variant arm emits `Regex.IsMatch` without the `using` → CS0103.
- **T5** — nested variant-`match` clobbers outer bindings in the shared
  dispatcher (`_expr/target.ts:264`, twin at :493): `matchBindings: new Map([[a.binding,…]])`
  replaces instead of extending `ctx.matchBindings`.

### Elixir / Python / Java backends
- **E1** — `int / int` diverges silently across backends: Java/.NET truncate,
  Python/TS/Elixir produce fractionals (`type-system.ts:589-593` types it `int`).
  Fractional "int" can fail integer casts at runtime.
- **E2** — live Ash-era code path emits `exists(rel, id == ^arg(:p))` into
  plain-Elixir op bodies (`elixir/render-expr.ts:644-679`, reached because the
  vanilla emitters set `ctx.agg`): `!(this.members.contains(memberId))` in a
  precondition → undefined `exists/2`/`arg/1` → `mix compile` fails. Verified
  against a generated fixture.
- **E3** — Elixir capability/write-scope filters rendered without `filterArgs`
  (`vanilla/capability-filter.ts:75/102/131`): `filter this.total > money("10.00")`
  emits the in-memory `Decimal.compare(...)` struct API inside `from(... where:)`
  → invalid Ecto → compile fails. Same for datetime order comparisons.
- **E4** — Python/Java import collectors skip variant-`match` subject/arms (and
  Python `list`) (`python/render-expr.ts:225-231`, `java/render-expr.ts:177-183`):
  a `money(...)`/`now()` trigger only inside a variant arm emits code without
  `BigDecimal`/`Decimal` import → Java compile error, Python `NameError`.
- **E5** — Python `%` uses floored modulo (`-5 % 3 == 1`) while Java/TS/C#/Elixir
  truncate (`-5 % 3 == -2`) (`python/render-expr.ts:613-617`).

### Frontends + body walker
- **F1** — `stringOrRefArgValue` renders a ref arg as a JS template literal
  `` `${id}` `` in the shared core (`walker-core.ts:1797-1800`); Flutter and Feliz
  splice it verbatim → invalid Dart/F#. Affects `Button(to: id)`,
  `Anchor(to: param)`, `Image(src: ref)`.
- **F2** — Svelte dynamic `renderStyleAttr` embeds `{rendered}` inside a quoted
  `style="…"` then entity-escapes every `"` (`svelte-target.ts:317-325`):
  `style: { color: active ? "green" : "gray" }` → `&quot;` inside a `{…}` JS
  expression → compile break. React/Vue/Angular render it fine.
- **F3** — Feliz `renderStateWrite` returns `"()"` for inline lambda handlers too
  (`feliz-target.ts:267-268`): `Button(onClick: e => { count := count + 1 })`
  emits `(fun _ -> ())` — a button that compiles and silently does nothing.
- **F4** — Flutter dynamic `testid:` emits `key: Key(dataTestid: <expr>)`
  (`flutter/pack.ts:97-106`), a named arg `Key` doesn't have → Dart compile error.
- **F5** — Flutter inline state writes emit `notifier.set<Field>(v)`
  (`flutter-target.ts:129-137`) but the Riverpod projector emits no `set<Field>`
  setters and binds `notifier` only when `usedActions.size > 0` → unbound
  `notifier` + nonexistent method.
- **F6** — Angular `renderForEach` omits the `emptyBody` seam param
  (`angular-target.ts:378-396`): `For { empty: … }` silently drops the
  empty-state arm on Angular only, despite Angular's native `@empty`.

### System / CLI / services
- **S1** — TPH column-rename intents target a nonexistent table
  (`migrations-builder.ts:1382-1394`, `resolveRenames` uses `plural(snake(agg))`
  where `resolveBackfills` correctly routes through `tableOwnerName`): a declared
  rename on a shared-table concrete degrades to drop+add → data loss.
- **S2** — `alterColumnType` is never classified destructive
  (`migrations-builder.ts:1086-1092`) despite the `allowDestructive` doc promising
  "narrowing type changes" are gated: `string → int` emits
  `ALTER … USING col::INTEGER` that fails/truncates at apply time, ungated.
- **S3** — the implicit rename heuristic misclassifies a genuine drop+add
  (`migrations-builder.ts:962-997`): any one-drop-one-add of the same column type
  is collapsed to `RENAME`, no name-similarity check, *before* the destructive
  gate — old data flows into an unrelated new column and the intended drop never
  trips `--allow-destructive`.

### Web / packages / scripts (incl. security)
- **W1 (security)** — the sandbox stub accepts `loom-init` from any parent origin
  and `document.write`s the payload (`web/public/sandbox/index.html:27-38`,
  checks only `e.source`, never `e.origin`) — an XSS primitive on the GitHub
  Pages origin with access to that origin's localStorage/OPFS.
- **W2 (security)** — `scripts/hex-mirror.py:66-67,118` binds `0.0.0.0:443` and
  relays to whatever `Host` header the client sends: an open TLS-terminating
  forward proxy / SSRF relay while it runs as root. Bind loopback + allowlist
  `*.hex.pm`.
- **W3** — `web/src/runtime/ddl.ts:243-270` drops foreign keys from synthesized
  DDL, so cascade deletes diverge from every real backend in the playground *and*
  the per-PR `behavioral-e2e` gate that reuses this module — deleting an
  aggregate orphans its children instead of cascading.
- **W4** — `web/src/runtime/runtime.worker.ts:492-539` — `setLogSink` races across
  concurrently-interleaved RPCs (the async `onmessage` doesn't serialize),
  misrouting/dropping backend logs; reintroduces the lost-structured-lines bug
  `console-tee.ts` documents fixing.

### Tests / CI / hooks
- **CI1** — the `tests-passed` roll-up omits `web-tsc` (`test.yml:183-194` vs the
  job at :204): a `src/` change that breaks `web/` typecheck merges green — the
  exact gap `web-tsc` was added to close.
- **CI2** — `test.yml:6-30` path filters omit `packages/**`, `stacks/**`,
  `api/**`, `vite/**`, `docker/**`, `sveltekit/**`, `bin/**`, `tsconfig.json` —
  all of which have tests or are compiled by tests; a PR touching only them runs
  no vitest, and a skipped required check counts as satisfied.
- **CI3** — `pipeline-layering.test.ts:96-105,88` — the layering guard classifies
  `import Foo, { type Bar }` as type-only (never inspects the default value
  import `Foo`), and `DYNAMIC_RE`'s lookahead excludes genuine runtime
  `import("…/system/x.js").then(...)` chains — two smuggling routes for a
  backward edge.
- **CI4** — `test/behavioral/run.mjs:194-236` passes vacuously on an empty corpus
  or zero emitted tests (`0 passed, 0 failed` → exit 0); a generator regression
  that stops emitting the suites turns the gate green. Also runs only the *first*
  e2e file per system (`:158`).
- **CI5** — `npm ci || npm install` in the behavioral/UI e2e workflows
  (`behavioral-e2e.yml:83` + siblings) silently discards lockfile enforcement,
  permanently masking `package-lock.json` drift.

---

## MINOR findings

Recorded per area (full detail in the per-area review notes). Highlights of the
recurring kinds:

- **Reserved-word escaping of `param` refs is missing on every backend**
  (TS/.NET/Python/Elixir/Java render `param` names verbatim while `let`/`lambda`
  are escaped): a DSL param named `class`/`from`/`end`/`new` emits non-compiling
  output. No validator reserves target-language keywords for params. *(This one
  is cross-cutting — worth fixing once at the validator level.)*
- **Stale removed-concept references** in live code/comments: Ash/`foundation:`
  in `elixir/render-expr.ts` (partly a live wrong path, E2), `transport: phoenix`
  in `lower-platform.ts:48-50`, `foundation: vanilla` in the k8s-e2e scripts, the
  orphaned page-`origin` doc block in `loom-ir.ts:2725-2734`, "two
  implementations" of `WalkerTarget` (six exist) and stale HEEx-parity banners in
  `_walker/registry.ts`.
- **Dead code**: `typescript/zod-refine.ts` (zero importers),
  `scaffold/_body-builders.ts:556` `scaffoldDetails`, `type-system.ts`
  `isPureExpression`/`SymbolOrigin`, `wire-projection.ts` update/UI filters
  (zero production consumers; the Elixir changeset re-implements the matrix by
  hand instead of consuming them).
- **Validator precision**: `validateStampReadsBeforeFlush` false-positives on
  unrelated hand-written stamps; `validateEventConsumersCarried` unions carriers
  across all contexts while routing is per-context (false negative);
  `decorative: false` satisfies the alt-text obligation (a11y);
  `checkParameterDefault` skips `destroy`/`function` members;
  `lvalueIsDerived` ignores let/param shadowing.
- **Divergent-hardening**: the Drizzle deep-scope tenant filter does no
  LIKE-wildcard escaping where .NET's `StartsWith` gets `ESCAPE`; the Python
  deep-scope predicate crashes (500) on a null claim where Elixir/Java fail
  closed; the shared TS audit-stamp helper unions stamp maps across aggregates.
- **`ensureFindAll` names the synthesized repository with naive `+s`**
  (`Category → Categorys`) instead of `plural()`.
- **The Enriched brand isn't carried through phase ⑦'s check leaves** — they take
  raw IR and down-cast per use, so an un-enriched fixture under-validates instead
  of failing to compile.
- **CI hardening**: 13 workflows have no `permissions:` block; actions floated on
  mutable major tags repo-wide; `biome.json` never lints `packages/**`; `test/**`
  is never typechecked anywhere; the `langium-generated` drift check can't see
  untracked new files; the pre-push merge hook's regex misses `git -C dir push`;
  the biome Stop-hook release warning is invisible to the agent (exit 0 stderr).

---

## Area health (one line each)

- **Language** — well-maintained; systematic weakness is drifting twins of
  member-lookup (optional-unwrap in 2/4 paths, extends-chain in 1/6 sites).
- **Macros + lowering** — lowering is architecturally clean and acyclic; the
  macro layer's worst defects are all *silent* (twins with no pinning test).
- **IR** — strong; clean layering and derived-on-demand wireShape; weak spots are
  stamped-vs-derived drift and scans that lag the lowering surface.
- **TS + .NET** — strong; the `ExprTarget` extraction pays off and v4/v5 Hono has
  no emitter divergence; weak spots are shape-combinations that escape the gates.
- **Elixir / Python / Java** — good structure, no tenant leak; risk in Elixir's
  two rendering modes leaking into each other and per-backend collector mirrors.
- **Frontends** — seam architecture is solid where test-gated; risk at the
  JS-assumption boundary breaking the two newest non-JS targets.
- **System / CLI / services** — strong; layering and error paths are careful;
  residual risk concentrated in the migration rename/destructive machinery.
- **Web / packages** — good; risk clusters in cross-window trust and playground
  fidelity/observability seams, plus the hex-mirror exposure.
- **Tests / CI** — unusually well-built (correct shard/blob-merge, honest opt-in
  gates); weaknesses are gate-perimeter coverage and layering-classifier
  precision.
