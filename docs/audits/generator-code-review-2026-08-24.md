# Generator code review — 2026-08-24

Reviewed on `main` @ `cc07658`. Method: seven parallel passes (the 57-commit merge window `5b88573..cc07658` diff-by-diff; a status verification of the 08-17 review's follow-up register; four deep passes — shared dispatchers + node, dotnet + java, python + elixir, the frontend walker layer; plan-vs-code cross-check + the system layer). Every finding verified by reading code on fresh `main`; items marked *reproduced* were verified by generating a real project from a probe `.ddd` and inspecting (or lint/type-checking) the actual output.

**Collision fence.** Findings claimed by open PRs are excluded and stay with their owners: #2659 (aggregate-less .NET handlers, java typed-id double-wrap, optional-find deref guards), #2653 (`Provenanced<T>` carrier), #2648 (not-found-from-READ + nightly alarm), #2646 (language-gap waves — projection-`where` gate, projection member typing, page enum refs, HEEx component state, cross-context domainService reads, feliz parameterised finds, elixir wire-shape residue), #2644 (the entire numeric F1–F18 register — flutter money, money form inputs, `int*money`, `int<decimal` elixir ordering, java decimal wire, migration precision/scale), #2628 (nav links to refused routes), #2604/#2647 (direct-caller drain), #2660–#2664 (CI-leg drafts). Where a fenced item was independently re-verified, that is noted without re-claiming.

Severity: **S1** = wrong/unsafe behavior in generated systems (security, data loss, silent wrong answers). **S2** = generated code fails to compile or a gate fails, but loudly. **S3** = debt/polish. Confidence stated per item.

---

## A. New unclaimed bugs, ranked

### A1. `shape: document` × capability filters × aggregation projection — broken on ALL FIVE backends; silent COUNT leak on dotnet/EF — S1, confirmed (reproduced on all five + dapper)

A query-time aggregation (`select total = count()`, sums) over a document-shaped source passes phase ⑦ but the emitters all assume relational columns. Born from the crossing of three window merges: #2609/#2637 (capability filters ANDed into direct-table aggregations, no shape guard), #2625 (deleted elixir's `tenantOwned × document` refusal, making the crossing reachable), and #2651 (whose columnless-source gate *deliberately keeps* `count()` over a document source, claiming it "runs on all five backends"). Per backend, for `aggregate Order shape: document, with tenantOwned, softDeletable` + `projection OrderVolume { from Order select total = count() }`:

- **dotnet/EF**: `_db.Orders…GroupBy(_ => 1).Count()` with **no filter at all** — document capability filters live in-app (`_CapabilityVisible`), not in `HasQueryFilter`, so this **compiles clean and counts every tenant's and soft-deleted rows**. The 08-17 A1 claim "EF was already correct" is false for the document shape. `src/generator/dotnet/query-projection-emit.ts:651`.
- node/drizzle: predicates over `schema.orders.tenantId` while the schema is `(id, data, version)` → TS2339 (`src/platform/hono/v4/projection-query-routes-builder.ts:730,755-780`).
- python: `OrderRow.tenant_id` on a model without the column → mypy fail / `AttributeError` 500 (`src/generator/python/query-projections-builder.ts:113-124`).
- java: JPQL over an `@Entity` that doesn't exist for document shape → runtime "could not resolve root entity" 500, **broken even with no capabilities at all** (`src/generator/java/emit/query-projection-reads.ts:148-214`).
- dotnet/dapper: SQL over missing columns → Postgres 42703 500; elixir: `mix compile` error (`src/generator/elixir/vanilla/query-projections-emit.ts:171`).

`scaffoldDashboard`'s `rowCount` tile survives `fieldsAreColumns(agg)=false` (`src/macros/stdlib/scaffold/_dashboard-shared.ts:24-38`), so a scaffolded dashboard over a document aggregate hits this. No fixture crosses `shape: document` × filtered aggregation. Fix direction: extend `columnlessProjectionSource` (`src/ir/util/query-projection-arm.ts:115-155`) to refuse aggregation over a capability-filtered non-column source (and repair or refuse java's independently-broken document `count()`), or lower the filters via jsonb accessors — either way, mint the fixture.

### A2. Drizzle predicate lowering INVERTS a comparison whose column is on the right — S1, certain (reproduced)

`src/generator/typescript/repository-find-predicate.ts:258-263` pulls the column from either operand but never commutes the operator: `find bigStock(): Item? where 100 < this.qty` emits `.where(lt(schema.items.qty, 100))` — i.e. `qty < 100`, the exact opposite. `eq`/`ne` are safe; all four inequalities invert. The validator admits the shape (`firstNonQueryableNode` walks operands symmetrically), and the class reaches every `lowerToDrizzle` position: find/retrieval `where`, capability `filter` (including hand-written tenancy-adjacent `filter now < this.expiresAt`), criterion bodies, write-scope predicates. Note `sql-pg-expr.ts` handles operand-order symmetry correctly — the shared layer already knows how. Fix: mirror the operator (`lt↔gt`, `lte↔gte`) when the column came from `e.right`.

### A3. The same shape on `persistence: mikroorm` emits a runtime-throwing stub the capability gate promised couldn't exist — S1, certain (reproduced)

`MIKROORM_SUBSET` (`src/ir/util/find-predicate-capability.ts:136-140`) treats comparison operands as symmetric, but `comparisonEntry` (`src/generator/typescript/emit/mikroorm.ts:1173-1195`) requires the column on the LEFT and throws otherwise — so `where 100 < this.qty` validates clean and emits `throw new Error("mikroorm v1: this find's predicate is not yet supported")` — a 500 on every call of a validator-accepted model. Must move together with A2 (commute in mikro too, or narrow the subset descriptor).

### A4. Elixir SSE realtime endpoint bypasses `auth: required` — S1, high

The `:sse` pipeline has no Auth plug (`src/generator/elixir/vanilla/shell-emit.ts:671-693`; route from `realtime-emit.ts:297-315`, #2624). The emitter comment claims parity with node/python "whose stream is likewise unauthenticated" — false on current main: node mounts `/api/realtime` behind `authMiddleware` and python's `AuthMiddleware` covers it; both 401 without credentials. Generated Phoenix streams to anyone, and untenanted broadcast events carry **full payloads** on this wire. Fix: add the Auth plug to the `:sse` pipeline (the pipeline split only needed to drop `:accepts`), or make the exemption an explicit cross-backend decision.

### A5. `bool` query/path params coerce through `z.coerce.boolean()` — `?f=false` parses as `true` — S1, certain (reproduced)

`src/platform/hono/v4/routes-builder.ts:2238` (`QUERY_PRIMITIVE.bool`) and `explicit-handlers-builder.ts:143-144` (path params). `Boolean("false") === true`, so `GET /flagged?f=false` (also `?f=0`, `?f=`) binds `true` and the find returns the opposite rows. #2566 fixed exactly this class for **bodies** (strict `BODY_PRIMITIVE`) but left the query/path tables coercing. .NET/FastAPI/Spring parse `"false"` as false — a cross-backend wire divergence too. Fix: explicit `"true"/"false"/"1"/"0"` enum-transform.

### A6. `audited`/`provenanced` on a RETURNING operation silently discards the whole return contract (node) — S1, certain (reproduced)

`src/platform/hono/v4/routes-builder.ts:1620` routes to `emitReturningOperationRoute` only when `op.returnType && !audit && !prov && !op.extern` — otherwise the op falls into the void-204 handler: for `operation take(n: int) audited : Item or NotFound` the route declares 204 only, drops the tagged result, and an error-variant return still saves and audit-logs `status:"ok"`. The in-code comment says "a later slice", but there is no validator refusal and no diagnostic — one keyword silently rewrites the HTTP contract. Minimum fix: a `loom.*` diagnostic for `audited|provenanced` × `returnType` on node; better: fold the audit tx into the returning route.

### A7. `-=` on a `datetime[]` (or object-element) collection compares by reference — silent no-op (node) — S1, high (reproduced emission)

`src/generator/typescript/render-stmt.ts:181-192` special-cases only money: `dates -= d` emits `findIndex((e) => e === (d))`; the wire value is a fresh `Date`, stored elements are hydrated `Date`s — never reference-equal, so the remove does nothing and returns 2xx. .NET's `List<DateTime>.Remove` uses value equality — divergent. Needs the money treatment (`getTime()` compare) and an answer for VO elements.

### A8. Java: #2656's SpEL sargable prefilter breaks every `EntityManager.createQuery` read over a deep/global-scoped aggregate — S1/S2 regression, high (reproduced)

`src/generator/java/render-jpql.ts:186-189` emits the deep-scope prefilter as a Spring Data SpEL parameter (`:#{…}`) unconditionally — but the `scope` arm is also reached in `principalAccessors` mode (query-time aggregations render `contextFilters` into raw JPQL, `src/generator/java/emit/query-projection-reads.ts:148-163`), where `:#{…}` is not a legal HQL parameter: Hibernate throws at parse, every projection read 500s. `scaffold + hierarchical tenancy + java` ships a dead dashboard. The .NET twin in the same PR got the mode split right (`dotnet/render-expr.ts:399-418` gates on `ctx.efQuery`). Fix: bind the pattern as another principal param when `ctx.principalAccessors` is set, computing the escape chain at the `setParameter` site.

### A9. .NET: durable-channel events no longer reach the SSE wire — regression from #2637's transactional-outbox capture — S1, medium-high (code-verified, all three legs)

Durable events now route through `RecordDurableAsync`, whose realtime decorator is a pure pass-through with no `_hub.Publish` (`src/generator/dotnet/emit/realtime.ts:385-389`), and both relays drain through the **raw** dispatcher, not the realtime tee (`emit/outbox.ts:193-194,278`; `emit/dapper-workflow.ts:617-618,722`). Net: a UI-observable event on a `retention: log|work` channel never produces an SSE frame on .NET (EF and dapper). Node tees in the relay (`hono/v4/emit.ts:1704-1711`); java tees on bus publish. The decorator's docstring now states the opposite of the code. Cheapest fix: `_hub.Publish` inside `RealtimeDomainEventDispatcher.RecordDurableAsync` before delegating.

### A10. Elixir deep-scope capability filter drops the declared tenancy claim at 3 of 4 call sites — S1/S2, high

`src/generator/elixir/vanilla/capability-filter.ts:119,145,180` call `renderDeepScopeEcto` without the `tenantClaim` argument, which defaults to `tenantId` (`render-expr.ts:741-744`); under `tenancy by user.<claim>` with claim ≠ `tenantId` the NULL-`data_key` floor reads `current_user.tenant_id` — a field the principal may not carry → runtime `KeyError` on every deep/global repo read. Sites at `capability-filter.ts:266` and `render-expr.ts:294` pass it correctly. The `tenancy-claim-name` fixture (minted for this bug class) never crosses claim-name × hierarchical scope — extend it with the fix.

### A11. `ignoring <Cap>` silently dropped on `platform: elixir` × `shape: document` finds — S1 (wrong data, fail-closed), high (reproduced)

`renderDocFindFn` never receives `f.bypassAll`/`f.bypassCaps` (`src/generator/elixir/vanilla/document-emit.ts:455,487,621`) even though `vanillaDocCapabilityFilter` supports `bypass` (`capability-filter.ts:296-309`); an admin "show deleted" find still filters deleted rows, no diagnostic. The relational elixir path and python's document builder both honour the clause. Introduced with #2625's in-app document filters. Related, still-open EF twin: the EF aggregation arm never calls `IgnoreQueryFilters()` (08-17 register item 1, `dotnet/query-projection-emit.ts:649-654,886`).

### A12. Computed `to:` on `Anchor`/`Button` silently dropped on six of seven frontends — S1, high (reproduced)

`stringOrRefArgValue` (`src/generator/_walker/walker-core.ts:2216-2234`) accepts only a string literal or bare route-param ref; any expression (`to: "/greet/" + who`) returns `undefined` and the primitive renders with **no navigation, no comment, no diagnostic** (react dead link, svelte fabricates `href="#top"`, flutter bare `Text`). HEEx alone renders it correctly (`heex-primitives.ts:101-128`) — proof of intended semantics. The degradation ratchet can't see it (the drop leaves valid markup). Fix: route dynamic `to:` through `emitExpr` on the other targets, or gate with a `loom.*` code.

### A13. i18n consumption gaps: modal trigger/submit labels and the sidebar render raw while their keys sit in the catalog — S2, high (reproduced)

- Modal trigger + op-form submit: the extractor catalogs `page.<P>.button.<hash>`, but JSX `emitModal` reads the label raw (`src/generator/_walker/primitives/forms.ts:913-916`), HEEx `renderModal` likewise (`heex-primitives.ts:239-247` — two lines below the *translated* `modalTitle`), flutter too (`flutter-target.ts:610-615`). A translated locale switches the dialog title but not its own trigger/submit.
- Sidebar: `menu.section.*`/`menu.link.*` keys are extracted (`i18n-extract.ts:247-263`) but `menu-emitter.ts` hands raw strings to the shells (`designs/mantine/v9/app-shell.hbs:129-130` renders `{{label}}` with no `t()`); localized apps get an English sidebar.

Both are the "extracted key nothing renders" tell the 08-17 review used; `user-visible-slot-coverage.test.ts` misses them because `Button` labels translate on the normal path.

### A14. Feliz: a page with a named (non-`id`) route param emits invalid F# and drops the param — S2, high (reproduced)

Two stacked causes in `src/generator/feliz/index.ts`: `pageView` passes `new Set()` for `paramNames` (:411 — every other target threads them), and `routePattern` (:523-543) binds only the first `:param` and renames it `id`. Result (`page Greet(who) { route: "/greet/:who" }`): `(* ref: who *)` empty headings plus `box (/* unresolved: who */ undefined)` — not F#, `dotnet fable` fails. All six other targets handle the same page. The degradation ratchet's only fixture has no named-route-param page — add one.

### A15. Angular + i18n: an apostrophe in any bound-attribute text slot crashes generation — S2, high (reproduced)

`angularTarget.renderAttrBinding` (`src/generator/angular/walker/angular-target.ts:498-503`) throws on mixed quotes; under i18n every bound label is `t("…", "<default>")` with double quotes, so `Tab { "Bob's", … }` kills the whole `ddd generate system` run with a stack trace — no diagnostic, all deployables lost. Vue solved the same problem by entity-escaping (`quoteAttrExpr`, `vue-target.ts:440`); Angular should escape, not throw.

### A16. Three ref-collection holes make generated python/elixir fail their own gates — S2, high (all reproduced)

One class, three collectors, each missing arms its twin has:

- **elixir**: `collectWorkflowStmtParamRefsAll`'s `repo-run` arm skips `page:` bound exprs (`src/generator/elixir/vanilla/workflow-execution-emit.ts:1187-1189`) → the M-T6.21 underscore rule renames a page-only `let` to `_cap` while the renderer reads `cap` → **`CompileError` on every `mix compile`** (python's twin walks page exprs).
- **python**: `collectUsedLetNames` (`src/generator/python/workflows-builder.ts:452-492`) has no `assign`/`domain-service-call`/`repo-delete` arms (elixir's has all three, with comments naming these exact failures) → the `let` is dropped as unused → ruff F821 + `NameError` (workflow routes, saga dispatch, explicit handlers).
- **python**: `stmtResourceOps` (`src/generator/python/resource-clients.ts:629-657`) walks `for-each` but not `if-let` bodies (nor `domain-service-call`/`repo-delete`) → resource-op call emitted without its import → F821 (#2652's handler leg and the workflow leg both).

The durable fix for all three is the exhaustive `walkWorkflowStmtChildren`/`walkWorkflowStmtExprsDeep` walkers in `src/ir/util/walk.ts` (which carry a trailing-`never` completeness guard) instead of hand-enumerated switches.

### A17. `when` gate at the domain method (#2596) never collects its predicate's imports — javac and CSC failures — S2, high (reproduced on both)

- java: `src/generator/java/emit/entity.ts:583-586` renders `op.when` but the import loop (:276-282) and regex hoist (:302-311) never visit it → `when this.owner == "system"` emits `Objects.equals(...)` with no `import java.util.Objects` ("cannot find symbol"); same for `matches()` (Pattern), `now()` (Instant).
- dotnet: `src/generator/dotnet/emit/entity.ts:420-423` vs the usings loop (:253-266) → `when this.code.matches("^sys")` emits `Regex.IsMatch` with no `using System.Text.RegularExpressions` → CS0103.

One-line fix per backend (add `op.when` to the collection loops + java's regex hoist); audit the route-layer twin for the same gap.

### A18. Dapper event-sourced repository drops the `User currentUser` find parameter — CS0535 + CS0103 — S2, high (reproduced)

`src/generator/dotnet/emit/dapper.ts:2105` renders ES find methods without `usesUser` and the usings block (:2113-2128) lacks `using <ns>.Auth;`, while the interface declares the trailing `User currentUser` (`emit/repository.ts:52-56`) — interface not implemented + unbound identifier, `dotnet build` fails. The document dapper repo (:1942) and the EF ES twin both handle it. Not covered by #2659.

### A19. Dapper relational optional find: `QuerySingleOrDefaultAsync` with no `LIMIT 1` — 500 on the second matching row — S2, high

`src/generator/dotnet/emit/dapper.ts:1531`: two rows matching a non-unique predicate (legal data) → `InvalidOperationException` → 500. EF/node/java/python return the first row. Fix: `QueryFirstOrDefaultAsync` + `LIMIT 1` (GetById is fine — PK).

### A20. Nested variant-`match` clobbers outer bindings in the shared expr dispatcher — S2, medium-high

`src/generator/_expr/target.ts:288-291` (and the marks twin :533-536) builds `matchBindings` as `new Map([[a.binding, bindingText]])`, REPLACING the outer map instead of extending it. Lowering supports nesting, so an outer binding read inside an inner arm falls back to a bare name that TS never declares → TS2304. Native-pattern backends escape by coincidence. Fix: spread the existing map in both dispatchers.

### A21. HEEx: `Anchor` with no `to:` emits `<.link navigate={}>` — S2, medium-high

`renderAnchor` (`heex-primitives.ts:101-128`): absent `to:` leaves `toExpr = ""` and falls into the dynamic branch — `navigate={}` is a HEEx tokenizer error at `mix compile`. JSX targets render a deliberate no-op anchor for the same input; mirror that.

---

## B. Cross-cutting observations on the remediation window

The 08-17 → 08-24 window was dominated by the 30-finding fleet (#2637) plus the adapter-parity drains. Verified overall sound (see §H), with a pattern worth naming: **three of this review's S1/S2 findings are regressions introduced by that window's own fixes** (A8 by #2656, A9 by #2637's outbox capture, and A1's reachability by #2625 + #2609's filter push-down), and two more (A16-elixir via #2639, A13 via #2637's partial i18n fix) are incomplete-fix residue. Each fix was mutation-proven against *its own* witness but not measured against the neighbouring mode/shape/adapter axis it changed — the same one-cell-fixed shape the audits keep finding in feature work. Recommendation in §F.

Window-specific notes:

1. **RFC 7807 `title` divergence under `httpStatus NotFound -> 410`** — #2620 switched four backends to title-on-resolved-status (`problemTitle(notFoundStatus)`), elixir still titles on the error name (`errorTitle("NotFound")`, `src/generator/elixir/vanilla/problem-details-emit.ts:346`, `denial.ts:106-109` — whose comment claims a java parity that no longer holds). `override-status-census.test.ts` asserts statuses only. S3, confirmed.
2. **Dead export `mikroProjectionWhere`** (`src/generator/typescript/emit/mikroorm.ts:1484`) — #2637's A1 mikro arm was superseded by #2609's `mikroCapabilityFilters` during rebase; zero callers remain, and #2637's mutation-proof narrative no longer describes main. Delete before an agent wires it "back" in. S3, confirmed.
3. **Two parallel gates for the same golden-coverage invariant** — `test/conformance/wire-golden-coverage.test.ts` (#2583) and `test/behavioral/golden-coverage.test.ts` (#2637 B1) assemble the same required set independently (shared registers, duplicated logic). Fold into one. S3.
4. **Elixir durable-emit tx wrap broadcasts PubSub *inside* the transaction** (`operation-returns-emit.ts:545,698-734`, `context-emit.ts:1075-1100`) — a commit failure after the broadcast lets SSE/LiveView observe an event whose write never happened; the non-durable branch documents the opposite (correct) ordering. Split: outbox INSERT inside, broadcast after commit. S3 (narrow window), high.
5. **#2575/#2631 merged-then-hotfixed pair** (dapper decimal aggregates) — resolved in-window, hotfix verified pinned; nothing to do.

---

## C. The 08-17 follow-up register — verified status

All 10 register items **remain open** on `cc07658`; none is claimed by an open PR. Updated evidence:

| # | Item | Status |
|---|---|---|
| 1 | EF aggregation `ignoring` never bypasses (`IgnoreQueryFilters` absent in `dotnet/query-projection-emit.ts` EF arms :649-654, :886) | OPEN — dapper-only fix landed |
| 2 | `money[]` fields don't round-trip on node (drizzle `string[]` vs `Decimal[]`; no array arm in `repository-find-hydrate.ts:147-213`) | OPEN — verified **not** in #2644's F1–F18 |
| 3 | Python audit-history `current_user_` F821 (gated-but-unmasked history route, `python/routes-builder.ts:987` vs import gate :330-333) | OPEN |
| 4 | mikroorm save path opens no transaction (`emit/mikroorm.ts:2385`; document/embedded/ES TS adapters likewise) | OPEN |
| 5 | Workflow/extern/timer outbox inserts outside any tx (deliberately fenced in #2637, `hono/v4/workflow-builder.ts:1222-1226`) | OPEN — needs the owner design ruling; **.NET document/ES repos share the shape** (`dotnet/emit/repository.ts:871-884,1060-1107`; `dapper.ts:2038-2045,2200-2202`) |
| 6 | Unescaped `data-testid="${testid}"` splices in `heex-primitives.ts` | OPEN — **grown to 19** sites; ~8 renderers also hand-roll literal-only testids (dynamic `testid:` silently dropped where JSX binds it). One-line fix each: the shared `testIdAttr` |
| 7 | `Button { icon:/loading: }` dropped on HEEx | OPEN (now rationalised in a comment, `heex-primitives.ts:1342-1354`; still untracked) |
| 8 | HEEx tab slug keeps spaces (`snake(label)`, :1640) | OPEN — also diverges from JSX's `slugify` for the same caption (cross-target e2e ids split) |
| 9 | packaging-split tests fail in git worktrees | OPEN |
| 10 | StmtTarget three preserved inconsistencies | OPEN by design — extraction itself landed (#2637); each normalization is a separately-gated byte-moving change |

Loose ends: **fixed by #2637** — C11 foundation vestige (residue: elixir vanilla-render-expr tests still pass `foundation:` in ctx literals), B5 golden slack (now derived exact-set), D2/D3 plan flips, C10's docs half. **Still open** — C9 (`Card variant/shadow` honoured by 3 of 15 packs), B4 (branch-protection up-to-date rule; the admin item sits on M-T9.7, which the 08-17 audit misnamed M-T6.7), C10's CI half (nothing ever emits a `node@v4` project), D5 (API versioning — golden count keeps rising), E7 (the runtime-gate parity manifest; #2640 covered the compile tier only, and draft #2664 will erase the headline asymmetry rather than manifest it).

---

## D. New technical debt

1. **Prototype-polluted 405 lookup** — `routes-builder.ts:372-374` emits `staticSubpathMethods[<segment>]`; `/api/items/constructor` under any verb → inherited member → `.includes` throws → 500. Use `Object.hasOwn`/null-proto. (From #2612.)
2. **Provenance leaf collection blind to `convert`/`duration`/`list`/`i18nFormat`/variant arms** (`src/generator/_stmt/leaves.ts:55-104`) — a provenanced `total := money(subtotal) * factor` records no leaf for `subtotal`. Pre-existing in all four copies; now one place to fix.
3. **Query-time projection `join` indexes the joined dictionary unguarded** — a deleted or capability-filtered-out join target → `KeyNotFoundException` (.NET `query-projection-emit.ts:1301`) / `.get(...)!` (node `projection-query-routes-builder.ts:649`) → 500 from ordinary data. Cross-backend debt.
4. **.NET explicit-route id coercion contradicts the id wire mapping** (`explicit-handlers-emit.ts:601,615`: `guid|long|string` vs java's `javaValueTypeForId`) — latent (ids are pinned guid today), breaks the day non-guid ids land. Align on `csIdValueClrType`.
5. **Handler atomicity asymmetry** — java explicit command handlers are class-`@Transactional`; .NET/node commit per `SaveAsync`. Partial-write window java doesn't have; belongs in the register-item-5 design ruling.
6. **Elixir seeder not atomic per dataset** (`seed-emit.ts:205-235` — per-row commits, marker last; a mid-dataset crash re-seeds duplicates; python's is one commit). Wrap in `Repo.transaction`.
7. **`propagateSinkFlags` is a diverging near-copy of `propagateChildFlags`** (`walker-core.ts:2038-2048` vs :1197-1216 — omits four flags); `stmtIsAwaited` (:1346-1348) doesn't recurse as its doc claims. Fold.
8. **Pack loader mutates global Handlebars state** (`_packs/loader.ts:255-268,311-319,355`); the "one pack per generation" comment is stale — a react+vue+svelte+angular system loads four packs into one registry; safe only while each frontend renders synchronously after its own load.
9. **i18n slot asymmetry**: `Stat` extracts label+value, `KeyValueRow` only the label (`user-visible-slots.ts:36,42-45`) — visually identical rows, one translatable.
10. **Stale descriptor prose**: `find-predicate-capability.ts:15-16` says drizzle's fallback is "a TODO comment"; the real behavior is a loud generation throw. Descriptor accuracy is what keeps A3-class gates honest. Also `reifiableCriterion` double-lowers every criterion body (`repository-find-predicate.ts:609-618` + :659).
11. **Elixir polish**: stale `@spec` on guarded returning ops (`| {:error, atom()}` vs the #2655 2-tuples, `operation-returns-emit.ts:901`); `FaultHandler` collapses `WrapperError` kind to `:error`.
12. **Flutter/feliz testid escaping**: flutter Timeline `Key('${tid[1]}')` bypasses `dartString` (`flutter-target.ts:720-723`); feliz/flutter keep HTML-entity-escaped text in non-HTML testids, so Playwright locators mismatch on `&`-bearing ids.
13. **System-layer residue for #2647's ratchet**: `test/_helpers/generate.ts:181` re-exports `generateSystems` (an import-path ratchet would miss it); `generateSystemFilesUnchecked` drops its `options` arg (:141); `assertGeneratable` + `generateSystems` double-lower/enrich every gated call (~4,100 calls per suite run).
14. **node `documentFindMethod` ignores `bypassAll`/`bypassCaps` on DECLARED document finds** (`src/generator/typescript/repository-document-builder.ts` — `documentCapabilityBody(agg, "x")` is computed once per aggregate and reused for every find, with no per-find bypass) — the same A11 class fixed for elixir on this branch, and python's document `findMethod` already recomputes with the find's own bypass. A `find … ignoring softDeletable` on a `shape: document` aggregate still filters the soft-deleted rows out: wrong data, fail-closed, no diagnostic. The synthesised query-time-projection reads added in the same file inherit it (a `projection … ignoring <Cap>` over a document source is likewise not bypassed on node). Recompute per find, as `renderDocFindFn`/python do.

---

## E. Plan hygiene (docs/new-plan) and open-PR claims

The README §Priority shortlist has rotted again within a week of its 08-17 rewrite — **4 of 5 rows point at shipped work**:

- Row 1 (M-T3.16 "the one P0, route left OPEN"): the emission landed (#2443 → #2446 → #2487 → **#2519** on all five backends; when-gate via #2596). Replace with the named residue (G1/S3/C2/C4); T3's "What is LEFT" still lists merged #2509.
- Row 2 (dapper/mikroorm axis): fully drained — M-T6.25 done, all five mikroorm emitters merged, the subtree remainder shipped (#2621), and `validateMikroOrmSupport` was **deleted** (#2623). Survivors: M-T6.35, the dapper raw-Npgsql aggregation arm.
- Row 3 (M-T6.30/M-T6.28): all shipped (#2641, #2520, #2645). Delete.
- Row 4: money.min/max/round shipped #2499; the multi-child sweep shipped #2637. Only flutter's 4 pinned form-field shapes survive.
- Row 5 (M-T9.13): the register holds **12** entries now (`test/ir/api-caller-census-pins.ts:492-579`), not 9; the two drainable entries are still undrained.

Track-file flips needed: **M-T6.38 → done** (#2596), **M-T6.23 → done** (#2621/#2623; also re-point `unsupported-register.ts:197-202`, whose `loom.mikroorm-unsupported` row cites a deleted raiser — the live one is `migration-checks.ts:254`), **M-T6.40 → done** (#2608), **M-T6.41 → partial** (#2609), **M-T9.21 → partial** (#2522/#2555; five-backend extension now claimed by #2664), **M-T9.35 → in-flight** (claimed by #2604/#2647 — as written it invites a duplicate claim), **M-T1.18** (Phase M-C/M-F shipped in #2619; body still says the opposite, as does M-T9.14). **Duplicate mission ID: `M-T6.43` heads two missions** (T6 lines 657 and 937) — the fifth dup-ID incident; renumber one, coordinating with #2644's M-T6.44–48 mints.

Open-PR claims: the #2659–#2664 gap-b3 wave is clean (disjoint claim-first drafts). **#2646 is dirty and partially duplicates merged work** — its base predates #2645 yet its wave-2 headline includes the same files-404 fix, and its 34-row `unsupported-register.ts` rewrite will collide with post-base register edits; needs a rebase that subtracts the shipped slice and a body update per the honest-claim rule. #2644 is sound but should re-run its ID-collision check at merge (M-T6.43 dup + #2646's audit doc share the namespace); its migration-differ claim was independently code-verified here (`columnTypeEqual`, `src/system/migrations-builder.ts:2664-2670`, compares only `kind` — #2575's own "an existing database migrates" claim is false). #2648 and #2664 edit the same waiver register — sequence, don't duplicate. The M-T9.34 phase-⑦ helper gate was adversarially checked and is **real** (non-vacuous freeze test, all three production surfaces gate ⑦).

---

## F. Architectural improvements worth doing now

1. **Normalize comparison operand order in ONE place.** A2/A3 exist because each persistence adapter re-decides "which side is the column". Either canonicalize at lowering (mirror the operator so the column is always left — one IR pass, every adapter and every future backend inherits it) or put the commute in a shared predicate-normalization helper the adapters must call. `sql-pg-expr.ts` already proves the shared layer handles it.
2. **Make emission *mode* part of the shared seam, not a per-arm guess.** A8 (SpEL vs bound-param) and A1 (columns vs document) are both "the arm didn't know which mode it was rendering for". The expression/JPQL renderers should take an explicit mode from `RenderCtx` (efQuery|principalAccessors; relational|document) and *refuse* — loudly, at generate time — a construct outside the mode's vocabulary, the way `_expr/target.ts` throws on `authz-filter`. That converts the next A1/A8 from a silent 500 into a one-line gate.
3. **One ref-walker per IR family, never hand-enumerated switches.** A16 (×3) and A17 are all "a collector missed an arm its renderer reads". `src/ir/util/walk.ts` already has exhaustive walkers with `never`-guards; migrate the elixir/python collectors and the java/dotnet import collectors onto them, then delete the local switches. This is the same discipline that killed the `bodyTypeOf` class in 08-17's A5.
4. **Give realtime a plan-level contract.** A4 + A9 show stream auth and the durable-event tee being re-decided per backend. `src/ir/util/realtime-rooms.ts` (already the shared room plan) should also state: streams inherit the deployable's auth mode; durable events tee at write-time. Emitters implement the plan; a conformance test asserts all five against it.
5. **i18n round-trip gate.** A13 and the register's slot findings share one shape: extraction and consumption read different tables. Add a generated-project gate: every catalog key must have a `t(key` consumption site in the emitted tree (per target), and vice versa for user-visible slots. That closes the class, not the instance.
6. **Fix-scope rule for the remediation fleets** (process, cheap): a fix that touches a mode/shape/adapter-split site must state in the PR body which *other* cells of that axis it re-verified (the A1/A8/A9 regressions all crossed an axis their witness didn't). The parity-gates matrix (#2640) is the checklist to cite.
7. Sanctioned and still queued: StmtTarget's three gated normalizations (register item 10), M-T9.26 RouteTarget, folding the twin golden-coverage gates (B3).

## G. Highest-leverage unclaimed work, ranked

1. **A1 + the document-shape gate/fixture** — five backends, silent leak on the one that compiles, scaffold-default exposure.
2. **A2+A3 via one commute fix** (+ corpus fixture with a value-on-left predicate) — data-inverting reads on the default node stack.
3. **A4 + A9 + the realtime contract (F4)** — two security/delivery holes, one seam.
4. **A16+A17 via the shared walkers (F3)** — five reproduced compile breaks, one refactor.
5. **A8** (java SpEL mode split) — un-breaks hierarchical-tenancy dashboards.
6. **A5** (bool coercion) + **A6** (audited-returning gate) — small node fixes, wire-contract class.
7. **A12–A15 frontend batch** — the silent-drop and crash class on the walker seam.
8. **Register drains**: EF `ignoring` (item 1), money[] on node (item 2 — unclaimed by anyone), python F821 (item 3), HEEx testid funnel (item 6).
9. **Plan hygiene batch (§E)** — the shortlist rewrite + status flips + the M-T6.43 renumber; cheap, prevents duplicate fleets.

## H. Checked and found sound

The window's headline merges verified end-to-end: #2637's relational A1 arms on all five backends (filter conjunction shapes, `ignoring` capability-origin-only, fail-closed principal binding), A2/A4 realtime claim-binding via `tenantClaimField` at all five sites, A3 outbox capture on node/EF/dapper/elixir relational, A5/A7/A10–A14 expression fixes, A17's `loom.unresolved-page-ref` with pinned controls; #2656's subtree-LIKE on ecto/python/dapper/drizzle (escape-first ordering, prefilter-plus-recheck making escaping non-load-bearing) — java's one bad mode aside; #2655's typed denial protocol; #2641's 7807 wrapper; #2652's resource clients (node/python/java sound; .NET's gap is #2659's); #2627/#2591 reserved-word quoting off the shared list; #2620's status resolution (titles aside); #2596 on node/dotnet/java/python (imports aside); #2608's macro-layer fix inheriting to all frontends. Shared layers: `_expr`/`_stmt`/`_type`/`_workflow` dispatch discipline, `sql-pg*.ts` quoting and operand symmetry, `zod-refine`'s two-gate structure, hono v5-as-pins, no ORDER-BY injection on any backend, dapper parameterization, .NET/java migration id collision-safety, the walker's #2637 multi-child sweep verified on all seven targets, #2654's api-param threading, showcase's generated python passing `ruff` + `mypy --strict` clean, and the M-T9.34 phase-⑦ helper gate (non-vacuous, all production surfaces covered).

---

## Follow-up register (2026-08-30, post-#2667)

Re-verified on `main` @ `aa236ae` — every row below was checked by reading (and, where marked *reproduced*, by generating from) code on that head, not carried forward from the sections above. The merge window since this review landed is #2667 (this review's own fix fleet), #2670 (M-T6.44), #2684/#2685 (schemathesis node script + pre-push hook), #2686 (F14) and #2687 (F15).

**Drained by #2667** (spot-verified here, not taken on trust): **all 21 §A findings** — A2's commute, A4's `:sse` Auth plug, A5's `QUERY_BOOL`, A9's `_hub.Publish` inside `RecordDurableAsync`, A12's `navArgValue`, A20's binding-map spread, and the rest; **§C register items 1 / 3 / 6** (`IgnoreQueryFilters([…])` in the EF aggregation arm, the python audit-history `require_current_user()` gate, the HEEx testid funnel — the only two `data-testid="${…}"` splices left both run through `escapeHeexAttr`); **§B1 / B2 / B4** (`problemTitle` on elixir, `mikroProjectionWhere` deleted, the PubSub broadcast split out of the transaction); **§D1 / D10 / D11 / D12**; and **§F1** — the shared operand normalizer now exists at `src/ir/util/comparison-operands.ts` (`orientComparison`) and both TS adapters call it (`repository-find-predicate.ts:265`, `emit/mikroorm.ts:1188`).

**Collision fence.** Open PR **#2668** (`claude/targets-implementation-gaps-s1gd08`, based on this same head) carries a 251-row gap ledger that already records most rows below under `G2667-*` ids. **Cite the ledger row, do not fork it.** #2668 also *claims and fixes* row 1 (`money[]` on node). One correction to that ledger: it buckets **§F5 as claimed by #2667 — wrong on this head** (see the queue table); §F1, §D10–D12 and §C6 are correctly bucketed.

| # | Item | Status on `aa236ae` | Evidence anchor | Owner |
|---|---|---|---|---|
| 1 | `money[]` doesn't round-trip on node | **OPEN — claimed by #2668** | `emit/schema.ts:885-903` emits `numeric(…,{precision:19,scale:4}).array()` (drizzle types it `string[]`); `repository-find-hydrate.ts:180` money arm is `primitive`-only, arrays fall through to the bare column at `:213`; `repository-save-builder.ts:358` likewise. Fence comment intact at `test/fixtures/corpus/collection-op-shapes.ddd:58-68` | ledger `G2667-C2`; #2668 edits hydrate/save/wire + adds `test/generator/typescript/scalar-collection-roundtrip.test.ts` |
| 2 | mikroorm save path opens no transaction | **OPEN** | `emit/mikroorm.ts:2358-2371` — `em.fork({keepTransactionContext:true})` then upsert + assoc + containment saves + event dispatch, no `em.transactional`; the drizzle sibling wraps in `db.transaction` (`repository-save-builder.ts:241,251`). TS document/embedded/ES adapters carry the same shape | ledger `G2667-C4` → **M-T4.3** remaining item 5 |
| 3 | Workflow/extern/timer outbox inserts outside any tx; .NET document/ES repos dispatch post-commit | **OPEN — needs the design ruling** | `platform/hono/v4/workflow-builder.ts:1239-1244` (the fence comment naming "timer / workflow emits that have no enclosing write tx"); `dotnet/emit/repository.ts:867-881` (document) and `:1082-1103` (event-sourced) both `SaveChangesAsync` then `foreach … DispatchAsync` | ledger `G2667-C5` (+ `G2667-D5`) → **M-T4.3** remaining item 5 |
| 4 | HEEx `Button { icon:/loading:/iconPosition: }` dropped | **OPEN — rationalised, untracked** | `heex-primitives.ts:1367-1379` — `passThroughAttrs: ["to","disabled","type","variant"]`; the comment states the reason (an undeclared attr on a Phoenix function component is a compile warning ⇒ a `--warnings-as-errors` build failure) | ledger `G2667-C7` · register-only |
| 5 | HEEx tab slug diverges from JSX | **OPEN** | `heex-primitives.ts:1641` `slug: snake(label)` — `snake` (`src/util/naming.ts:17`) only case-splits and lowercases, so spaces survive; the JSX twin is `slugify` (`_walker/shared/args.ts:11`, non-alnum → `-`) at `primitives/layout.ts:289`. Same caption, two ids | ledger `G2667-C8` · register-only |
| 6 | `packaging-split-{fs-discovery,core-pkg}` fail in git worktrees | **OPEN** | both resolve `repoRoot/node_modules/@loom/*` via `discoverBackendsFs(repoRoot)` (`test/platform/packaging-split-fs-discovery.test.ts:31,36`; `packaging-split-core-pkg.test.ts:22`) — a workspace symlink tree only the primary checkout has | ledger `G2667-C9` · register-only |
| 7 | StmtTarget's three preserved inconsistencies | **OPEN by design** | all three markers present: temp numbering `_stmt/target.ts:61` + `typescript/render-stmt.ts:157` / `dotnet:110` / `java:98` / `python:123`; provenance gating `typescript:316` / `python:82` vs `dotnet:242` / `java:244`; the dead `segments.length !== 1` guard survives at `dotnet:225,262` and `java:227,262` | ledger `G2667-C10` · register-only |
| 8 | C9 — `Card { variant:, shadow: }` honoured by few packs | **OPEN — count refined** | of the 15 packs shipping `primitive-card.hbs`: **3 honour both** (mantine v7, mantine v9, vuetify v3), 4 honour `variant` only (mui v5/v7, chakra v2/v3), 1 honours `shadow` only (shadcnSvelte v1), **7 honour neither** (spartanNg, angularMaterial, shadcn v3, shadcn v4, shadcnVue, flowbite, primeng) | ledger `G2667-C-looseends` · register-only |
| 9 | B4 — branch-protection "require branches up to date" | **OPEN — now tracked** | `M-T9.7` carried only RST-4; the up-to-date rule is added to that mission this pass (it is an owner click, not code) | **M-T9.7** |
| 10 | C10 CI half — nothing emits/compiles a `node@v4` project | **OPEN** | `grep -rn "node@v4" .github/ scripts/` returns only `actions/setup-node@v4`; the pin is exercised solely by parse/lower unit tests (`test/platform/backend-platform-pin.test.ts:41-105`). zod-3 compatibility remains comment discipline | ledger `G2667-C-looseends` · register-only |
| 11 | D5 — API versioning watch item | **OPEN — unchanged, cost still rising** | no proposal, no mission; `docs/new-plan/coverage.md:273` still records "whoever picks it up writes one and adds a mission under T5". The byte-exact golden count is now **50** (`test/behavioral/wire-golden/*.json`), which is the number the watch item is about | coverage.md · register-only |
| 12 | E7 — the (feature × backend × runtime-gate) manifest | **CHANGED — narrowed, not drained** | the headline asymmetry is gone: `schemathesis.yml:70-110` fuzzes node/python/dotnet/java as binding cells, and its F14/F15 findings are FIXED (#2686 / #2687 — see `schemathesis-findings-2026-08.md`). What is left: (i) elixir is still a `continue-on-error` **discovery** cell running its own `ELIXIR_CASES` fixture, and (ii) there is still no manifest — the compile tier has one (`test/platform/backend-parity-gates.test.ts`), the queue lane is per-workflow (`test/system/merge-queue-required-checks.ts:82-92`), and nothing states which *runtime* gate covers which backend for which feature | register-only |
| 13 | `ignoring` after `group by` parses, then is silently dropped | **OPEN — reproduced** | the grammar puts `IgnoringClause?` in the `where` position (`ddd.langium:1581-1586`), but a `group by` operand is an `Expression` and `PostfixChain` admits a trailing `IgnoringClause` (`:2322`). Generated from `projection-groupby.ddd` + `softDeletable`: with the clause after `group by`, node emits `.where(and(eq(status,"Confirmed"), not(eq(isDeleted,true))))`; moved into the `where` position it emits `.where(eq(status,"Confirmed"))`. Clause order is load-bearing and nothing says so | **M-T5.25** (new) |
| 14 | python `dispatch-builder.ts` emits no domain-service imports | **OPEN — reproduced** | the file never calls `domainServiceImportLinesForWorkflow`; its only callers are `workflows-builder.ts:257` and `emit/aggregate.ts:266`. A saga `on(…)` handler calling `Retry.nextAttempt(1)` emits a bare `next_attempt(1)` at `app/dispatch.py:31` with no import → ruff F821 / `NameError` | **M-T6.50** (new) |
| 15 | own-state assign in a command workflow renders `self._x` at module level (python) | **OPEN — reproduced** | `workflows-builder.ts:582` builds the route target with `thisName: "self"` and the `assign` arm (`:817-823`) renders the own-state LHS through it, but the emitted route is a module-level `async def`. `counter := 1` → `self._counter = 1` in `app/http/workflows_routes.py` → F821 | **M-T6.50** (new) |
| 16 | `collectStmtExprImports` misses `variant-match` | **OPEN — latent** | `python/emit/domain-service.ts:243-265` switches on 10 of the 11 `StmtIR` kinds; `variant-match` and its nested statements have no arm, while the two exported collectors in the same file already ride `walkStmtExprsDeep`/`walkWorkflowStmtExprsDeep` (`:283-296`). §F3's exact shape | **M-T6.50** (new) |
| 17 | `Image`/`Avatar` `src:`/`alt:` still on the pre-A12 helper | **OPEN — wider than recorded (4 sites, not 2)** | `_walker/primitives/text.ts:172,178` (Image) and `:197,200` (Avatar) call `stringOrRefArgValue` (`walker-core.ts:2228`), whose own doc-comment now describes it as the helper A12 replaced. Both A12 defects ride along: a computed value returns `undefined` and the attribute is silently dropped, and a route-param ref returns a JS **template literal** (`` `${id}` ``) — invalid F#/Dart, invalid in a markup attribute | **M-T1.26** (new) |
| 18 | node `documentFindMethod` ignores `bypassAll`/`bypassCaps` | **OPEN** | `repository-document-builder.ts:325` computes `documentCapabilityBody(agg,"x")` with no per-find bypass; the elixir twin threads it since the A11 fix (`elixir/vanilla/document-emit.ts:641`), and the synthesized query-time projection reads inherit the hole (`:89-90`). Recorded above as §D item 14 | **M-T6.51** (new) |
| 19 | java document-source aggregation — the real fix | **OPEN — honestly refused** | `PROJECTION_DOCUMENT_AGG_SUPPORTED = {node, python, elixir, dotnet}` (`ir/validate/checks/system-checks.ts:340`); java raises `loom.projection-whole-table-aggregation-unsupported#document` / `loom.projection-groupby-unsupported-backend#document`, and `scaffoldDashboard.macro.ts:78` documents the skip. **Register prose is now stale**: the `loom.projection-whole-table-aggregation-unsupported` row at `src/diagnostics/unsupported-register.ts:345-352` still reads "ships on all five backends — latent seam for a NEW backend" | **M-T4.2** residue |
| 20 | Generated SPAs cannot authenticate their own SSE stream | **OPEN — now uniform on every backend** | `_frontend/realtime.ts:54` emits a bare `new EventSource(\`${API_BASE_URL}/realtime/events\`)` — no `withCredentials`, no token param — while elixir's `:sse` pipeline now carries the Auth plug (`elixir/vanilla/shell-emit.ts:670-687`, the A4 fix) alongside node's `authMiddleware` and python's `AuthMiddleware`. On an `auth: required` deployable the stream 401s every generated frontend. M-T1.10 recorded the opposite ("an app-config concern, not emitted-client code"); corrected this pass | ledger `G2667-F4` → **M-T4.12** (new) |

### Architecture queue (§F) — verified status

| Item | Status on `aa236ae` | Evidence |
|---|---|---|
| F1 — normalize operand order in one place | **FIXED-BY-#2667** | `src/ir/util/comparison-operands.ts` `orientComparison`, consumed by `repository-find-predicate.ts:265` and `emit/mikroorm.ts:1188` |
| F2 — emission *mode* in the shared seam | **done** (Wave 2 packet 2.4, #2770) | `src/generator/_expr/target.ts:QueryEmissionMode`/`QUERY_EMISSION_VOCABULARY`/`refuseOutOfVocabulary` is the declared seam; `java/render-jpql.ts:73` `isEntityManagerMode(ctx)` (via `JpqlCtx.mode`) replaces the `if (ctx.principalAccessors)` branch this row named, and every out-of-vocabulary fallback across the query-language renderers (JPQL, `sql-pg-expr.ts`, dotnet dapper raw SQL, python SQLAlchemy, node Drizzle) routes through `refuseOutOfVocabulary` instead of an ad hoc throw. `test/generator/_expr/emission-mode.test.ts`. Ledger `G2667-F2` done |
| F3 — one ref-walker per IR family | **PARTIAL** | A16's three collectors now ride `src/ir/util/walk.ts` (`python/workflows-builder.ts:28`, `python/resource-clients.ts:2`, `elixir/vanilla/workflow-execution-emit.ts:90`); row 16 above is the un-migrated residue. Ledger `G2667-F3` |
| F4 — realtime plan contract | **OPEN** (subsumes row 20) | `src/ir/util/realtime-rooms.ts` still states rooms only; stream auth and the durable-event tee are re-decided per backend. Ledger `G2667-F4` → **M-T4.12** |
| F5 — i18n round-trip gate | **OPEN** | #2667 added the A13-*instance* gate `test/generator/_walker/i18n-dead-key-cross-target.test.ts` (its own describes are `A13a` / `A13b`), not the general "every catalog key has a `t(key` consumption site per target, and vice versa" gate. **#2668's ledger buckets this as claimed — it is not** → **M-T9.39** (new) |
| B3 — fold the twin golden-coverage gates | **OPEN** | both still exist independently: `test/conformance/wire-golden-coverage.test.ts` and `test/behavioral/golden-coverage.test.ts`. Ledger `G2667-B3` |
| F6 — fix-scope rule for remediation fleets | **OPEN (process)** | a PR-body rule, not code; ledger `G2667-F6`. Register-only — it belongs in the runbook when someone lands it |
| M-T9.26 — `RouteTarget` | **OPEN, unblocked** | `docs/new-plan/T9-toolchain-health.md:126`, with its "re-verify the pre-#2462 census" caveat intact |
