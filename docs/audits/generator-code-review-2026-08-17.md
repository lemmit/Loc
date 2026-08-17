# Generator code review — 2026-08-17

Reviewed on `main` @ `5b88573`. Method: five parallel deep-review passes (shared emitter dispatchers; the five backend generators; the frontend walker/pack layer; the last ~30 merged PR diffs; plan-vs-code cross-check), every finding verified by reading code on fresh `main` and — where marked *reproduced* — by generating a real project and running the actual target-language compiler/linter against the output.

**Collision fence.** Findings already claimed by open PRs are excluded here and stay with their owners: #2592 (targets completeness audit), #2574/#2587 (phase ⑦ generation gate), #2591 (Dapper reserved-word quoting), #2581 (scaffold page gates + the ungated default sidebar follow-up), #2583 (page identity / `area`), #2566 (schemathesis F1/F7 node), #2568 (component reads on feliz/flutter), #2569 (history `Timeline`), #2575 (money grouping-key + `NUMERIC(19,4)` DDL), #2541 (4xx wire goldens), #2588 (retro §86–88).

Severity: **S1** = wrong/unsafe behavior in generated systems (security, data loss, silent wrong answers). **S2** = generated code fails to compile or a gate fails, but loudly. **S3** = debt/polish. Confidence is stated per item.

---

## A. Unclaimed bugs, ranked

### A1. Query-time projection **aggregations** bypass capability filters — cross-tenant leak — S1, confirmed (reproduced)

`projection X { from A … select n = count(), s = sum(a.f) }` (whole-table and `group by` shapes) reads the source table directly and ANDs in only `p.query.filter` — never the source aggregate's `contextFilters` (`tenantOwned`, `softDeletable`, any `filter` capability). The row-shaped sibling goes through the synthesized repo find and *is* scoped.

- node: `src/platform/hono/v4/projection-query-routes-builder.ts:152-172` (`aggWheres`), `:176-182` (`mikroWheres`) — reproduced: `db.select({ total: count(), … }).from(schema.invoices)` with no tenant predicate while the same run's `invoice-repository.ts` carries `eq(schema.invoices.tenantId, requireCurrentUser().tenantId)` on every find. The repository even gets a **scoped** method emitted (`invoiceTotals()`), which the route never calls.
- python: `src/generator/python/query-projections-builder.ts:98-102` — same shape, reproduced.
- java: `src/generator/java/emit/query-projection-reads.ts:167` — JPQL from selects only, reproduced.
- dotnet/**dapper**: `src/generator/dotnet/query-projection-emit.ts:480,487` (+ `670/673`, `913/916`, `1049/1052`). dotnet/**EF is correct** (inherits `HasQueryFilter`, `src/generator/dotnet/emit/efcore.ts:258-292`) — two adapters of one backend disagree.
- **elixir is correct** (`src/generator/elixir/vanilla/query-projections-emit.ts:164-180` calls `vanillaCapabilityFilter`, honours `ignoring`).

With `softDeletable` alone this is a plain wrong number (aggregates count soft-deleted rows `findAll` excludes) — no auth needed. `scaffoldDashboard` (`src/macros/stdlib/scaffold/scaffoldDashboard.macro.ts:23-46`) emits exactly this shape, so a scaffolded dashboard on a multi-tenant system shows **global** totals. The same construct honestly refuses `mask unless` (`loom.field-mask-projection-source`) — the mask boundary was reasoned about; the filter boundary was not. No corpus fixture combines a projection with a capability filter, so no gate can see it; the fix should mint one.

### A2. Realtime rooms hardcode the claim name `tenantId` — S1/S2, confirmed (reproduced)

`tenancy by user.<claim>` binds an arbitrary claim, but all four SSE emitters spell `tenantId` literally:

- `src/platform/hono/v4/realtime-builder.ts:177-178`, `:237-239`
- `src/generator/dotnet/emit/realtime.ts:268` (`__rtUser.TenantId`)
- `src/generator/java/emit/realtime.ts:343` (`user.tenantId()`)
- `src/generator/python/realtime-builder.ts:236` (`user.tenant_id`)

With `tenancy by user.orgId`: **.NET and Java fail to compile** (the principal record has `OrgId`/`orgId`), **python raises `AttributeError` per publish**, and **node silently reads `undefined`** through its `as { tenantId?: unknown }` cast — every connection joins no room and every tenant-scoped event degrades to a broadcast to *all* tenants. The repositories in the same run bind the claim correctly. `tenancy-claim-name.ddd` exists for this bug class but carries no broadcast channel — extend it. Structural fix: the claim binding belongs in the shared plan (`src/ir/util/realtime-rooms.ts`), one fix instead of four.

### A3. The transactional outbox is not transactional on node, .NET, and elixir — S1, confirmed

`docs/channels.md:134` (and the dispatch-delivery proposal §91-101) require the outbox row in the *same* transaction as the aggregate save.

- node: `src/generator/typescript/repository-save-builder.ts:226-247` — the `db.transaction` closes at `:235`, then `:238` dispatches; `createOutboxDispatcher` (`src/platform/hono/v4/workflow-builder.ts:1181-1187`) inserts on the pool. Two transactions.
- .NET: `src/generator/dotnet/emit/repository.ts:489` — `SaveChangesAsync` commits, then `DispatchAsync` adds + second `SaveChangesAsync`. No transaction spans both.
- elixir: `src/generator/elixir/channels-emit.ts:131-134` — the emitted comment claims the insert "joins the caller's `Repo.transaction`"; the emitted caller has none. The comment states the opposite of what the code does.
- java ✓ (class-level `@Transactional` spans both), python ✓ (one session per request).

A crash between the two commits silently loses a durable event — the exact window the outbox exists to close. Invisible to every gate because the relay drains fine on the happy path.

### A4. Realtime tenant classification is fail-open — S1, likely

`src/ir/util/realtime-rooms.ts:63-71` marks an event tenant-scoped iff it carries an `<Agg> id` field pointing at a `tenantOwned` aggregate. An event with scalar payload about a tenant-owned aggregate but no id field lands in the **global** set and streams to every tenant's clients (verified in the generated `TENANT_SCOPED_EVENT_TYPES`). The safe default for an unclassifiable event out of a tenant-owned context is the ticket, not the payload. `docs/new-plan/T1-ui-frontend.md:166` conflates "declared `crossTenant`" with "declares no id field".

### A5. `bodyTypeOf` has no `binary` arm — money `sum(λ)` with arithmetic breaks on 3 of 5 backends — S1/S2, confirmed (reproduced on all five)

`src/util/expr-body-type.ts:47-76` types only ref/member/paren/convert/ternary/literal. Java has its own richer probe (`sumElementType`, `src/generator/java/render-expr.ts:645-674`) handling `binary`; node (`typescript/render-expr.ts:446-457`), python (`python/render-expr.ts:532-542`) and elixir (`elixir/render-expr.ts:866-877`) all probe through `bodyTypeOf`. So `sum(l => l.price * l.qty)` — the canonical order total:

| backend | emitted | outcome |
|---|---|---|
| node | `reduce((acc, x) => acc + …, 0)` | tsc fails (`number + Decimal`) |
| elixir | `Enum.sum(Enum.map(…, Decimal.mult(…)))` | compiles green, **`ArithmeticError` at runtime** |
| python | `sum(...)` without `Decimal` start | mypy `--strict` fails; empty collection yields int `0` (the #2549 class) |
| java / dotnet | correct | — |

The same missing arm degrades `min`/`max`/`sortBy` money detection; elixir's sorter fallback is `&<=/2` — structural `%Decimal{}` term comparison, i.e. **silently wrong ordering** with no error. No fixture anywhere uses an arithmetic lambda body, `.distinct`, `.any()` or `sortBy(` — which is why no compile gate sees it. Fix in one place: add `case "binary": return e.resultType ?? e.leftType;` (and likely `method-call → e.memberType`) to `bodyTypeOf`, then delete Java's local duplicate.

### A6. Flutter cannot round-trip a `money` field — S1, confirmed (reproduced)

`money` rides the wire as a JSON **string** (`repository-wire-builder.ts:149` `.toFixed(4)`; the emitted `wire-spec.json` says `{"type":"string","format":"decimal"}`). Flutter decodes `(json['price'] as num).toDouble()` and encodes a bare double (`src/generator/flutter/dart-types.ts:112-114`, `:143`) — every read throws (`String is not a subtype of num`), every write POSTs a number the backend's `z.string()` rejects. Feliz and the four JS frontends are correct. Nothing catches it: `flutter analyze`/`build` are blind to a runtime cast, and `frontend-fullstack-e2e.yml` does not drive flutter.

### A7. `Tab` drops every body child after the first — the class #2567 just fixed for `Card` — S1, confirmed (reproduced on all seven targets)

`src/generator/_walker/primitives/layout.ts:241` reads `tabPositionals[1]` alone; the HEEx engine has the identical line at `src/generator/elixir/heex-primitives.ts:1505`. `Tab { "Ovw", Text{"A"}, Text{"B"} }` drops `B` on react/vue/svelte/angular/flutter/heex (on feliz it survives only in the i18n catalog). Bonus inconsistency: the dropped literal **is** extracted into `.loom/messages.en.json` — translators get a key nothing renders. Same single-slot reads with lower blast radius: `KeyValueRow` (`primitives/text.ts:294`), `Stat` (`primitives/display.ts:41`), `Modal`'s non-`OperationForm` positionals (`primitives/forms.ts:875`). The #2567 fix (`positionals.slice(1)`) is the template; sweep the class, don't fix one member.

### A8. `when` state gate not enforced off the aggregate route — S1, confirmed (previously filed, unclaimed)

An operation invoked from a workflow step or extern handler never evaluates its `when` gate; it succeeds (verified node + .NET; #2520's own body calls it "a strictly worse defect than the envelope one, and it is unfixed"). Filed as **M-T6.38**, P1, no PR. Its mission text is explicit that the *first step is no code*: finish the per-backend verification table and get the route-layer-vs-domain-layer decision D-tagged. Don't build either answer first.

### A9. `lowerComponent` threads `user: undefined` — `currentUser` in component bodies escapes its gate — S1/S2, confirmed

`src/ir/lower/lower-ui.ts:462` vs `:318`: pages get the system user block, components get `undefined`, so a component body's `currentUser` lowers to an unresolved ref and never reaches `loom.current-user-needs-auth-ui` (gap documented in place at `src/ir/validate/checks/system-checks.ts:585-590`, admitted in #2551's body, never picked up).

### A10. Java descending `sortBy` emits code javac rejects — S2, confirmed (reproduced with javac)

`src/generator/java/render-expr.ts:713-719`: `Comparator.comparing(λ).reversed()` takes the receiver out of target-typed position → `T` infers `Object` → *cannot find symbol*. Ascending compiles fine. `test/generator/java/render-expr-kinds.test.ts:279-281` **pins the broken string as expected output**. Fix: `Comparator.comparing(f, Comparator.reverseOrder())`.

### A11. Unary `-` on money: node and Java emit uncompilable code — S2, confirmed (reproduced)

The `unary` leaf is a bare `${op}${operand}` on four targets (`typescript:104`, `dotnet:238`, `java:383`, `python:107`); only elixir dispatches money (`Decimal.negate`, `elixir/render-expr.ts:1095-1131`). The type system admits `-price` on money (`type-system.ts:527-531`), so java emits `-this.price` (bad operand type) and node types `-p` as `number` (TS2322). Make the four targets money-aware (elixir's `isDecimalOperand` probe is reusable) or reject it in the validator.

### A12. Elixir argless `any()` renders an always-false predicate — S1, confirmed (reproduced)

`src/generator/elixir/render-expr.ts:821`: default lambda is `fn _ -> false end` → `lines.any()` is always `false`. Every sibling defaults to "non-empty" (TS `.some(() => true)`, .NET `.Any(_ => true)`, java `!isEmpty()`, python `len > 0`); elixir's own `all` default is right — a copy-paste inversion. Compiles clean, silently wrong.

### A13. Java `remove` on an `int[]` collection binds `List.remove(int index)` — S1, confirmed (reproduced)

`src/generator/java/render-stmt.ts:122-125`: `codes -= v` with `List<Integer>` + `int v` picks the **index** overload — removes the wrong element or throws `IndexOutOfBoundsException`. Fix: `remove(Integer.valueOf(v))` when the element type is `int`.

### A14. TS `distinct` (and `-=`) compare money by reference — S1, confirmed (reproduced)

`TS_COLLECTION_RENDERERS.distinct` (`typescript/render-expr.ts:404`) is `[...new Set(recv)]` — decimal.js instances never dedupe. The table already special-cases money for `contains`/`sum`/`sortBy`/`min`/`max`; `distinct` was missed. Same identity bug in `typescript/render-stmt.ts:166` (`findIndex(e => e === value)` for `-=` over money/VO collections).

### A15. Python: `contains` under a negation trips ruff E713 — the `python-build` gate fails — S2, confirmed (reproduced)

`PY_COLLECTION_RENDERERS.contains` emits bare `x in y`; `renderPyNegatedGuard` (`python/render-expr.ts:179-186`) exists but four emitters wrap `not (...)` themselves: `python/emit/aggregate.ts:658,662`, `emit/value-objects.ts:117-118`, `emit/wire-constraints.ts:134`, `routes-builder.ts:957`. A positive `invariant tags.contains("x")` generates `if not ("x" in self._tags):` → E713 under the generated project's own ruff rule set. Route those four sites through the existing helper.

### A16. Elixir silently clamps out-of-range `page`/`pageSize` while publishing bounds — S2 (contract), confirmed

`page_param/4` (`src/generator/elixir/vanilla/find-controller.ts:334-345`, duplicated at `explicit-handlers-emit.ts:626-637`) clamps and defaults; `openapi-emit.ts:1224-1225` publishes `minimum: 1, maximum: …`. Elixir answers `200` where node/python answer `422` and java/dotnet `400` — the schemathesis F2/F3 self-contradiction class, invisible because schemathesis only runs the node leg and no wire case sends an out-of-range page.

### A17. Unresolved bare `ref` in markup position renders a comment — the last unguarded silent-drop door — S1, confirmed (reproduced)

`src/generator/_walker/walker-core.ts:1073`, `:2462`: `Text { nosuchthing }` passes phases ④ and ⑦ and emits `{/* ref: nosuchthing */}` (`SizedBox.shrink()` on flutter, `Html.none` on feliz) on all six frontends. Calls have `loom.unknown-page-element` and actions have `loom.unresolved-action-ref`; refs have no equivalent. Add the diagnostic; this closes the #2554/#2567/#2568 class's remaining entry point.

---

## B. CI / process — the structural fixes behind the recent main-reds

Verified state: `main` is **green** — the projection-join golden landed inside #2567; #2590 was closed unmerged as a duplicate repair (the second duplicated main-red repair in 48h, one merge after #2582 wrote the claim-the-repair runbook entry).

1. **A fast-suite golden-coverage gate** (highest leverage, ~1s, no boot). #2577's missing-golden check lives inside a *booted* runner (`test/behavioral/wire-differential.mjs:143-158`), so a PR that mints a recorded case without its golden passes `test.yml` and reddens only the heavy legs — the mechanism behind main-reds #4 and #5. Add `test/behavioral/golden-coverage.test.ts` to the fast suite: derive the required case set the way `cases.mjs` does (manifest + behavioural blocks + `systems/*.ddd` + `corpus.json`, minus `BEHAVIOURAL_SKIP`/`GOLDEN_OPT_OUT`), assert `wire-golden/<case>.json` exists. Blocker: `BEHAVIOURAL_SKIP` is module-private in `cases.mjs` — export it.
2. **Six YAML lines: add `test/fixtures/corpus/**` to the behavioral workflows' path filters.** None of the seven `behavioral-e2e*.yml` legs trigger on corpus edits (the one elixir hit is a cache key), yet the corpus manifest is the tier's *input*. A pure-fixture PR mints recorded cases on seven legs and fires none of them; `pr-gate` treats path-skipped as passing. `corpus-build.yml` gets this right.
3. **Register `BEHAVIOURAL_SKIP` (and `GOLDEN_OPT_OUT`) in `test/platform/allowlist-ratchet.test.ts`.** The ratchet watches 15+ registers but not the one carrying 4 live entries, 3 of them provably stale (see D2). #2545 fixed this for `MIKRO_SKIP` in the same file without generalizing, and admits the asymmetry in its body.
4. **Branch protection: "require branches to be up to date before merging"** — the unlisted 80% of the merge queue. §87 verifies no such rule exists today; four merge-pair collisions in five days (#2546/#2550/#2557/#2578) plus #2590 all get caught by forcing the PR's CI to re-run on post-collision `main`. One admin click; belongs on M-T6.7's `blocked(admin)` list, which currently names only `behavioral-python`.
5. `test/ir/api-caller-census.test.ts:386` guards `WITH_GOLDEN` with `>= 20` against a population of 45+ — a golden-less case silently drops out with ~25 cases of slack. Tighten to an exact pin or a ratchet.

---

## C. Technical debt

1. **`StmtTarget` extraction is now justified — the "deliberately not extracted" comment no longer matches the code.** All four `render-stmt.ts` files (ts 294 / dotnet 329 / java 258 / python 233 LOC) share the identical 12-kind switch, arm order, `variant-match` throw, chunking helpers, precondition trace shape, `withValueComputed` guard, and provenance wrap; genuine divergence is confined to the indent model and per-arm spelling — exactly the `WorkflowStmtTarget` shape already proven in `src/generator/_workflow/stmt-target.ts` for the same four backends. The side-by-side also exposed two live inconsistencies an extraction would fix: python numbers temps per-kind while the others use the statement index, and the provenance gating differs (ts/python honor `emitProvenance`; dotnet/java gate on `prov` presence and both carry a dead `segments.length !== 1` guard). Frame as a re-measure with a byte-identical gate, per the repo's own extraction discipline.
2. **Stale M-T6.25 skips.** `BEHAVIOURAL_SKIP["dotnet { persistence: dapper }"]` still carries three entries whose stated reason ("dapper emits no query-time projection reads") is false since #2559 landed the emitter. The mission's own acceptance step — delete the entries, re-run `run-dapper.mjs` — was not executed.
3. **`zod-refine.ts`'s private renderer has drifted from `TS_TARGET`** (`:233-256` knows 7 of 16 collection ops; unknown ops fall through to non-JS `.take(...)`; `sum`/`contains` lack money handling; `let`/`lambda` refs skip `escapeTsIdent`). Latent today because `classifyForWire` excludes most of it (`invariant-classify.ts:271-278` — which also makes the "money → `.gt`" comment at `zod-refine.ts:38` describe an unreachable case), but each widening of `classifyForWire` silently arms it. Either narrow it with a `default: UNRENDERABLE` throw or drive it from `TS_TARGET`.
4. **Regex-literal hardening exists once and wasn't reused.** `typescript/render-expr.ts:723-738` (`asRegexLiteral`) handles empty pattern / trailing backslash; `src/generator/zod-refine.ts:56,226` and `src/generator/angular/form-validators.ts:115` do a bare slash-escape (`matches("")` → `.regex(//)` comments out the line). Export and reuse.
5. **Java ignores the `_obs` catalog** — `src/generator/_obs/log-events.ts` declares itself the single source of truth; no file under `src/generator/java/` imports it (event names are string literals across `emit/observability.ts`, `emit/api.ts`, `emit/channels.ts`, `emit/auth.ts`). The catalog header is also stale (omits python).
6. **Stale comments naming a deleted validator.** `src/generator/typescript/repository-find-predicate.ts:505-522` and `src/ir/validate/checks/system-checks.ts:3085` cite `validatePrincipalContextFilterSupport`, which no longer exists — and the emitter demonstrably applies the filters the comments say are rejected. Plausibly how A1 slipped in. Scrub both.
7. **HEEx page-body layout fidelity.** `heex-parity.test.ts` pins renderer *existence*, not fidelity: `CLOSED_PRIMITIVE_SPECS` (`heex-primitives.ts:1217-1252`) renders `Stack`/`Grid`/`Card`/`Container`/`Toolbar` as bare `<div>`s with no layout classes at all, and unknown named args fall through to invalid HTML attributes (`cols={[3,2,1]}` is a render-time failure). Also `heex-primitives.ts:700` splices `Column` labels into a quoted attribute unescaped. Phoenix pages are functionally unstyled while all 15 JSX packs carry real layout — a per-primitive fidelity gap the freeze list structurally cannot see.
8. **i18n slot ratchet gone vacuous for three modules.** `i18n-slot-inventory.test.ts:80` decides "localizes" via a per-file regex its own header warns about; `primitives/inputs.ts` (all input labels), `layout.ts` (Tab label), `data-grid.ts` (Column header) now pass the proxy while emitting untranslated authored text (reproduced: `t()` and raw `label="Email address"` in the same generated page; `chrome.sortBy` translates while the column header it describes does not). Quarantine them in `PARTIALLY_LOCALIZED` or fix the slots.
9. **`Card { variant:, shadow: }` honoured by 3 of 15 packs** (mantine v7/v9 both; vuetify `variant` only; twelve ignore both silently). The required-emit gate checks template presence, not knob consumption — the "dead catalog" shape again.
10. **hono v4 is pins-only but unverified** — nothing in CI ever emits a `platform: node@v4` project; zod-3 compatibility is comment discipline. Also `docs/platforms.md:19,68,78` still names v4 the default; `src/platform/registry.ts:66` resolves `node → v5`.
11. **`RenderCtx.foundation?: "vanilla"`** (`elixir/render-expr.ts:100`) — single-valued vestige of the removed `foundation:` axis threaded through ~30 call sites.
12. Unused imports on `main` (Biome warnings, "incomplete refactoring" residue): `src/platform/hono/v4/routes-builder.ts:62-63` (`operationIsGuarded`, `operationUsesCurrentUser`), `src/generator/typescript/emit/tests.ts:1` and `src/generator/python/emit/tests.ts:1` (`createOmissionValue`, `forCreateInput`).
13. #2564's commit subject says "the registry is empty"; one .NET decimal-precision waiver remains (the file header at `test/_helpers/wire-waivers.ts:38-42` is honest; only the subject overstates).

---

## D. Plan hygiene (docs/new-plan)

1. **README priority shortlist: three of five rows point at shipped work.** M-T9.11 gap 1's "blocked on harness" (landed, #2515); M-T9.25 round-2 401/403 arms (swept, #2540); the angular/feliz `KNOWN_DEGRADATIONS` entries (register is empty); M-T1.3's `CHART_FRAMEWORKS` (all seven, `system-checks.ts:416-424`). M-T3.16's true remainder (C2/C4) is claimed by #2541. Rewrite the shortlist before an agent picks from it.
2. **M-T6.23 marked `done` while a gate is live**: `validateMikroOrmSupport` still refuses hierarchical tenancy on mikroorm (`system-checks.ts:2995-3010`; live `kind:"gap"` row at `unsupported-register.ts:198-202`). Flip to `partial` with the subtree predicate as the named remainder.
3. **M-T9.13 counts wrong**: README says 7 fixtures in `E2E_LESS_CORPUS_FIXTURES`; the register holds 9 (`test/ir/api-caller-census-pins.ts:469-531`), and two (`policy-document`, `lifecycle-guard`) cite #2515's harness gap as their blocker *in the entry text* — that blocker shipped; both are drainable now. `lifecycle-guard`'s stated reason ("no negative-status assertion form") is also stale post-#2570 `AUTHZ_LADDERS`.
4. **#2588 (open) has a section-number collision**: it appends §86–88 while `experience_gathered.md` already carries §86–89 (different heading spelling, so it merges cleanly and silently duplicates numbers). Renumber to §90–92 before merge; also add #2590 as the fifth §86-class incident.
5. Old-plan → new-plan mapping is clean (no silently dropped promises; the six `coverage.md` unmapped items are declared). One watch item: **API versioning** has no proposal or mission while the wire-golden tier pins byte-exact bodies across five backends — its introduction cost rises with every golden minted.

## E. Highest-leverage unclaimed work, ranked

1. **A1 + a corpus fixture** (projection aggregation × tenancy/softDelete) — security, four backends, scaffold-default exposure.
2. **B1 + B2** (golden-coverage fast gate + corpus path filters) — kills the dominant recurring main-red class for ~50 lines total.
3. **A2/A4 via the shared seam** — move claim binding + fail-open classification into `realtime-rooms.ts`, fix once.
4. **A5** (`bodyTypeOf` binary arm) — one-file fix, deletes Java's duplicate, un-breaks money folds on three backends; add the missing fixture shapes (arithmetic lambda, `distinct`, argless `any`, `sortBy` desc) to the corpus so A10–A14 get permanent witnesses.
5. **A3** (outbox atomicity) — node/dotnet/elixir; needs a crash-window test (kill between save and dispatch, assert the event survives).
6. **A7 sweep** (`Tab`/`KeyValueRow`/`Stat`/`Modal` multi-child) + **A17** (`loom.unresolved-page-ref`) — closes the silent-drop class.
7. **Gate-parity manifest** — a (feature × backend × runtime-gate) manifest in the style of `unsupported-register.ts`, so asymmetries like "schemathesis is node-only" and A16 are stated facts, not prose. Complements (does not duplicate) #2592's hand-built audit.
8. **StmtTarget re-measure** (C1) and **M-T9.26 RouteTarget slice 0** — the two sanctioned architecture items, both unclaimed.
9. Plan-ranked unclaimed missions whose blockers self-resolved: the scaffolded `Chart` dashboard tile (M-T1.3 tail — `CHART_FRAMEWORKS` is complete, the `<Agg>PerDay` projection and `Stat` row already exist), M-T6.30 (vanilla Phoenix RFC 7807 app-global arm), M-T6.37 (elixir seeder), M-T9.13 drains.

## F. Checked and found sound

Read gates (#2523/#2570): all five backends emit all four gate sites of `read-gates.ddd`, folded-projection gate precedes the by-key lookup. Lifecycle write gates (#2519): load→gate→write order and 404-beats-403 placement identical on all five. `/api/auth/me` (#2561). Money wire scale (#2560) reaches all five + both .NET adapters. `sort`/`dir` allowlisted server-side everywhere (no ORDER BY injection); dapper's `whereToSql` parameterises runtime values; containment loads are bulk, not N+1. Duration seam (#2553): all arithmetic/comparison paths covered on all five; divergent stringifications are unreachable by construction. #2567's `Card` fix is correct on all six walker targets; `emitSlot` hardening is tight; pack loading fails loudly; `readsOf` is genuinely single-source; JS-family text escaping covers all three interpolation syntaxes. Recent merge window: waiver registries moved the right way (wire-waivers 5→1, schemathesis −20 lines, dapper skips 2→0), no `it.skip`/`it.only` introduced, the four new TODOs are the lint-visible `TODO(flutter full-parity)` markers.
