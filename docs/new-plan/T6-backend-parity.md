# T6 — Backend parity & generated-code quality

> **Completed missions for this track live in [`archive/T6-done.md`](archive/T6-done.md)** (38 closed as of 2026-09-02). This file lists only the live missions.

*The core matrix (CRUD/relational/ES/inheritance/audit/tenancy) is genuinely all-5 converged, and `backend-parity-gates.test.ts` ("gated xor emitted") is the strongest anti-rot seam in the repo. What's left is a short residue — but several residues have the WRONG failure mode (silent output or generator crash instead of an honest `loom.*` gate). Converting those is cheap and high-value.*

## M-T6.2 — Vanilla-Phoenix gap register drain — `partial` · **M–L** · P2
**ES applier folds — silent fallthrough removed AND every fold shape DRAINED (this session).** The `# unsupported applier statement` comments (`eventsourced-emit.ts` aggregate fold + `workflow-eventsourced-emit.ts` workflow fold) were the last silent-if-reached fallthroughs: a `+=` / `-=` in an `apply(e: E) { … }` compiled GREEN while dropping the transition at runtime (data loss), because the fold renderer only handled `:=` / `let` / `expression`. Both folds now share `src/generator/elixir/vanilla/fold-stmt-emit.ts`, which renders EVERY fold shape and THROWS on anything else (exhaustive dispatch — the discipline validator already rejects `emit`/`call`/`precondition`/`requires`):
- scalar (`balance -= e.amount`) → arithmetic; primitive-collection (`tags += e.tag`) → list append; value-object-collection (`charges += Money{…}`) → plain map appended inline;
- contained-**entity-part** construction (`boxes += Box{…}`, incl. part-in-part) → a plain map over the part's wire shape with a minted `id` + `[]`-defaulted nested containments, since the ES path emits no `%Ctx.Box{}` Ecto struct (mirrors node's `Box._create({ id: Ids.newBoxId(), … })`). No `loom.vanilla-es-applier-*` gate — the shapes are emitted, not gated.

Two adjacent gaps drained with it: (a) a `Money[]` value-object *collection* on an ES aggregate previously emitted a table-backed `<agg>_charges` Ecto schema `belongs_to`-ing the plain-struct ES aggregate (a `mix compile` error over a table the migration never creates) — the value-collection schema emitter now skips ES aggregates (the collection folds inline); (b) `validateVanillaContainmentSupport` wrongly fired for an event-sourced aggregate's part-in-part — it now skips ES aggregates (their parts fold in memory, no relational child tables). All compile-gated by `test/e2e/fixtures/elixir-vanilla-build/vanilla-es-applier-fold.ddd` (`mix compile --warnings-as-errors`, verified — scalar + primitive + VO-collection + entity-part + part-in-part in one aggregate). KNOWN CROSS-BACKEND CAVEAT: minting the contained-part id in the fold is non-deterministic across replays — a shared ES-contained-part limitation on every backend, own follow-up.

**§11c deep part-in-part — DRAINED (this session).** A part that itself declares `contains` (part-in-part) on a RELATIONAL state-based aggregate is now emitted, so `loom.vanilla-containment-unsupported` is **fully retired** (`validateVanillaContainmentSupport` deleted). The gate's stated reason — "the shared migration emits no grandchild table" — was **stale**: the shared `MigrationsIR` DOES carry the grandchild table (python's SQL migration emits it), but the *elixir* migration emitter's part tier only emitted parts FK'd to a parent AGGREGATE, silently dropping one FK'd to a sibling PART (`tags` → `lines`). Fixed across: the migration emitter (grandchild tables emitted after their tier-0 parent, FK-topologically; tier-0 numbering byte-identical), `renderPartSchema` (a relational part's own `contains` → `has_many` on its grandchild table + `belongs_to` its DIRECT parent via `directParentName` + `cast_assoc`), and the read/update preload (`readPreloadRels` nests `[lines: :tags]`). **Boot-verified** on real Postgres: a nested `create → read` round-trip (Order → lines → tags) persists via recursive `cast_assoc` and reads back the nested tags. Compile fixture `vanilla-relational-part-in-part.ddd` + generator/validator tests pinned.

Remaining rows of the old gap register (re-verified 2026-07-13): **§12 residual** document-shape gate still rejects audited/provenanced ops, collection mutation, derived reads (blocked on shared bug #1765), dereferenced-entity members, paged/union finds — drain or leave honestly gated; **§14 tail** audit `wireSnapshot` + `WorkflowsController` `serialize/1` snake_case leak; **§13** LiveView action-button auth not actor-threaded from `socket.assigns`; Phoenix OpenAPI surface for workflow-instance views.

**Register re-verified again 2026-08-14** (docs-only pass, `ae0cb24`) — two corrections to the paragraph above: (a) the **§14 tail is four sites, not two** — `workflow-execution-emit.ts` and `audit-emit.ts` as listed, **plus** `explicit-handlers-emit.ts` (the same `defp serialize(%_{} = struct)` dump on the explicit query/command-handler controller; the file postdates the original count) and a deliberate, in-code-documented carve-out in `eventsourced-emit.ts` (an ES aggregate carrying a **ref collection** keeps the raw dump, because `__ref_ids/1`'s Ecto-assoc semantics don't hold for an in-memory fold). The workflow + explicit-handler serializers are being drained now. (b) the **§12 collection-mutation** clause can no longer lean on "gated upstream by `loom.vanilla-containment-unsupported` anyway" — that gate is retired (see the §11c drain above), so the clause stands on its own. Also confirmed spent and marked as such in the archived doc: §11's "To restore the gate" block (the 5-backend `conformance-parity` flip has landed — `examples/showcase.ddd` carries `platform: elixir`, no skip variable in the workflow), §2's remaining ask (now **inverted** — the wire settled on an *untagged* success record and `union-wire-parity.test.ts` pins that, so acting on the row would regress union parity) and §4's dead-Ash-arm cleanup (done; `relationshipNameFor` has zero occurrences).
Sources: [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §11c/§12/§13/§14, [vanilla-document-route-a](../old/plans/vanilla-document-route-a.md).

## M-T6.3 — Phoenix output hygiene: `mix format` + Dialyzer gates — `deferred` (slice 1 landed) · **L (was M)** · P2
**Slice 1 landed** (`.formatter.exs` scoping): the generated `lib/<app>_web/api/**` OpenApiSpex layer (`<api>_spec.ex` spec module + request/response schema modules) is a machine-emitted nested-struct literal `mix format` reflows by width — **~73% of the whole format diff** on a broad project, never hand-edited — and is now excluded from the format gate via a computed `inputs` (rejects the `_web/api/` subtree, correct for any app name; `renderVanillaFormatterExs`, `shell-emit.ts`).

**Gate activation deferred** after a source-grounded scoping (2026-07-21, real `mix format` in the `hexpm/elixir` image, api_spec excluded):
- `mix format` is **deliberately non-configurable** — no per-rule toggles, no `# format: off` ignore comments/regions. The only dials are `line_length`, `locals_without_parens`, and which files are checked. So the "un-handy" rules (blank-line insertion, `case`-clause consistency, call-wrapping) **cannot be suppressed by config**.
- `line_length` is the one lever for the dominant width-driven wrapping, but it **plateaus**: on the `vanilla-workflows` fixture the churn falls 447→253 diff-lines (98→200) then flattens — an **irreducible ~250-line / 20-file structural residual** (blank lines + clause consistency + un-wrapping emitter pre-wraps) no config reaches. Pushing `line_length` past ~150 also just trades wrap-churn for collapse-churn and leaves 150-col lines.
- Closing the residual means teaching **~10 emitters** (controllers, context, changeset, telemetry, boilerplate, workflows) to replicate the formatter's width + blank-line + clause rules — an **L grind, and brittle**: every future Elixir-emitter edit can silently re-break the all-or-nothing gate, re-checkable only via the slow docker+hex-mirror `mix format` loop. Payoff is cosmetic — generated Elixir already compiles `mix compile --warnings-as-errors` clean.
- **Decision: defer the gate** (same disposition as M-T6.20 — L/risky for a narrow benefit). Reassess if a cheaper mechanism appears (e.g. a real ignore-comment lands in Elixir, or the emitters gain a shared format-aware line builder). Dialyzer/Credo remain future nightly-only.

Reusable tooling from the scoping: a real-formatter diff loop (`startHexMirror` → `generate system` → `mix format` with `import_deps` resolved → diff) makes the grind a measure-fix-remeasure cycle if picked up.
Sources: [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §7, [static-analysis-followups](../old/proposals/static-analysis-followups.md) Slices 1–2.

## M-T6.11 — Reserved compose slots (was: `PlatformSurface` hooks, DEBT-27) — `blocked(T3/T4 features)` · — · P3
**Corrected 2026-08-14 — the five hooks this mission named do not exist.** `PlatformSurface` (`src/platform/surface.ts`) declares exactly one `emit*` method, `emitProject`; `emitAuthGate` / `emitCompliancePolicy` / `emitTenancyFilter` have zero occurrences anywhere in `src/`, and `emitAuditInit` / `emitI18nAdapter` survive only inside the doc comments of the slots below (a dangling reference worth scrubbing when someone next touches that file).
What is genuinely reserved-but-unwired is **three optional data slots on `ComposeServiceShape`**, undefined on every backend, which the compose orchestrator skips when absent: `auditSidecar` (a separate container draining audit-record events — M-T4.x audit), `policyInitCmd` (an entrypoint wrapper that loads/verifies compliance policies before the main service — M-T3.x authorization/compliance), and `i18nCatalogDir` (the in-container mount path for the i18n catalog — M-T1.11). Tenancy has no reservation at all: multi-tenant filtering ships through the capability/stance machinery ([`docs/tenancy.md`](../tenancy.md)), not a surface hook.
Disposition unchanged: don't build speculatively — each slot fills when its owning feature reaches emission. Tracked here so they aren't forgotten or cargo-culted.

## M-T6.13 — OpenAPI tag grouping — `open` · **S–M** · P3
Doc-level `x-tagGroups` per served `api` across the five backends (design audited + simulated; resolve decision (f) on .NET/Java per-op tags first).
Sources: [api-openapi-tag-grouping](../old/proposals/api-openapi-tag-grouping.md), ddd-review api-grouping gap.

## M-T6.18 — Argument/parameter type-checking is systemically missing — `partial` (gap #1 constructions + gap #2 calls fully closed; gap #3 remains) · **L** · P1 ⭐ wrong failure mode (all targets)
An audit of every argument/parameter-passing call site (triggered by the `match await` arg gap, M-T6.17) found the AST type-system **defers arg arity/type checking** (`src/language/type-system.ts:742`) and `checkCallStmt` (`statements.ts:343`) only resolves the callee's *existence*, never compares `stmt.args` to its params.  So wrong arguments slip through at MOST call sites and mis-generate broken target code — caught only downstream by `tsc`/`gradle`/`mix`, **not by Loom**.  A `.ddd` that passes validation can emit code that doesn't compile.  **Checked today (good):** `emit Event { … }` (`checkEmit`, fully typed), `Action` on a param-op, `match await` args (M-T6.17), scalar intrinsics, `days(n)`, and the *arity* of `criterion`/`policy-fn`.  **Confirmed GAPS (each reproduced — generates broken code, zero Loom errors):**
1. **Record / VO / error / payload CONSTRUCTION** `Money { amount: "x", bogus: 3 }` — wrong field type, missing required field, AND unknown extra field all slip (`builder-call.ts` `checkBuilderCallType` resolves the type NAME but never the entries).  **Top severity** — every record literal in the language.  **Slice 1 landed** (#1966): `loom.unknown-construction-field` (`builder-call.ts` `checkConstructionFields`) rejects an entry naming a field the record (VO / entity part / record payload) doesn't declare — the zero-inference sub-check (unknown field NAME); zero false-positives across the whole example corpus.  **Slice 2 landed:** `loom.construction-field-type` (`statements.ts` `checkConstructionArgTypes` + `builder-call.ts` `recordFieldTypes`) type-checks each entry's VALUE against the declared field type for constructions reachable from an operation/create/destroy body — hooked into the statement walk (needs the lexical `Env`), mirroring `checkEmit`'s `unknown`-suppression + numeric-literal-promotion; full suite green, zero false-positives.  **Slice 3 landed:** the same `checkConstructionArgTypes` is now invoked at the non-body construction sites too — property defaults (`checkPropertyDefault`), `derived`/`invariant` bodies, and `function` bodies (expr + block form) in `types.ts` — so record field VALUES are type-checked at EVERY construction site.  **Slice 4 landed (completeness):** `loom.construction-missing-field` (`builder-call.ts` `checkConstructionFields`, beside the name check) rejects a construction that OMITS a required field — a declared non-optional, non-defaulted, non-`provenanced` `Property` (`contains` members auto-default empty, so they're never required); positional-entry constructions are skipped to stay conservative; full suite green, zero false-positives.  **The construction gap (name + value type + presence) is now closed** for VO / entity-part / record-payload builds.  Remaining: entry-value type-check inside page/workflow bodies (those walk their own env surfaces).
2. **Domain op / function / workflow-op calls** `bump("hi")`, `derived x = fee()`, `o.bump(a)` — arity + type unchecked.  **Slice A landed:** `loom.call-arg-count` / `loom.call-arg-type` (`statements.ts` `checkCallArgs`, wired into `checkCallStmt`'s bare + member branches) checks arity + per-arg type on every RESOLVED statement-level call, mirroring `checkEmit`'s `unknown`-suppression + numeric-literal-promotion; full suite green, zero false-positives.  **Slice B landed:** the EXPRESSION-position FREE calls (`derived x = fee(a)`, `let y := compute(a, b)`, `precondition check(a)`) — new `freeCallFunction` (type-system.ts, in lockstep with `typeOfFreeCall`) resolves a free call to its user `FunctionDecl` (undefined for VO ctors / criteria / policy-fns / duration builtins), and `checkExprCallArgs` (statements.ts) arg-checks those through the shared `checkCallArgs`, hooked at the statement walk + non-body sites; full suite green, zero false-positives.  **Slice B tail landed:** `checkExprCallArgs` now also covers EXPRESSION-position MEMBER calls (`derived t = price.scaled(f)`) via a running-receiver-type walk (`typeAfterSuffix` + `stepIntoNode`), which resolves a callee only for function/operation members of an entity/aggregate/VO receiver — so collection ops (`.sum`/`.count` on arrays) and scalar intrinsics are naturally skipped; full suite green, zero false-positives.  **Gap #2 is now fully closed** — every operation/function call (statement + expression, free + member) is arity- and type-checked.
3. **Workflow `create` field TYPES** (names checked, types not — `workflow-checks.ts`, IR-level so no lexical env); **UI component prop passing** `Panel(amount: "x")` (missing/extra/wrong-type, unchecked); **store action calls** `Cart.add(42)` (unchecked); **criterion/policy-fn arg TYPES** — **first slice landed:** `freeCallPredicate` (type-system.ts) + `checkArgTypesPositional` (statements.ts) type-check criterion/policy-fn calls at the env-bearing sites `checkExprCallArgs` already walks (bodies / preconditions / requires / derived / …); arity stays owned by `checkCriteria`/`checkPolicyFns` (type-only, no double report); full suite green.  Remaining: the `from X(args)` / `where:` / `when` criterion sites (own env surfaces), plus the component-prop / store-action / workflow-create-field-type items above.
   HIGH regression risk — the whole example/test corpus constructs records and calls ops, so any resolver bug false-positives broadly; land incrementally (start with #1), run the FULL suite each slice, mirror `checkEmit`'s `unknown`-suppression + numeric-literal-promotion (`canPromoteLiteralTo`) to avoid ergonomic false positives.
Sources: this session's parameter-passing validation audit (repros under the auditor's `/tmp/audit/`); `src/language/validators/{builder-call,statements,criterion,policy-fn}.ts`, `type-system.ts:742`, `src/ir/validate/checks/{ui-checks,workflow-checks}.ts`.

## M-T6.14 — Small parity leftovers — `open` · **S** · P3
DEBT-12 Phoenix `verify_token` niche; DEBT-08 `envelope` carrier (deferred — no live use; signpost via M-T5.9a); saga/projection EF `HasColumnName` correlation-column bug (from S7 Slice C review); domain-seam log-catalog §3 residue ⚠ partly stale.

## M-T6.41 — a direct-table aggregation applies NO capability `contextFilters` — on BOTH adapters · `partial` ([#2609](https://github.com/lemmit/Loc/pull/2609) — drizzle / mikroorm / python closed; the dapper raw-Npgsql arm is the residue) · **M** · P2 ⭐ silent wrong answer
*(ID note: minted as M-T6.40 in #2533, renumbered here — #2551 claimed M-T6.40 for the Elixir list-page compile bug and merged first. Third dup-ID incident this week; M-T9.32's automation is the fix all three evidence.)*

Found 2026-08-12 by an owner review of M-T6.23 slice 4 (PR #2533), and it is **not** a mikroorm bug — the default drizzle path has it too, which is why no adapter-parity gate could see it.

A query-time projection whose `select` is an aggregation reads the source table **directly** (that is the point of the shape — it pushes down to SQL and materialises no rows). Both adapters build that query from the projection's own `where` alone:

- drizzle — `db.select({…}).from(schema.orders).where(<the projection's filter>)`
- mikroorm — `createQueryBuilder(OrderRow, "src").select([raw(…)]).where(<the projection's filter>)`

Neither one ANDs in the aggregate's capability `contextFilters` — the predicates that `softDeletable` / `tenantOwned` / any `filter` capability contributes to *every other* read of that table (`findById`, `findManyByIds`, `findAll`, named finds, retrievals all get them). So:

- a `softDeletable` source counts **soft-deleted rows** in its totals;
- a `tenantOwned` source counts **every tenant's rows** — a cross-tenant read, in the same class as the .NET document-shape hole fixed in #2530, and reachable by any dashboard `count`.

It is a **silent wrong answer**, not a crash: the number looks plausible. The row-sourced shapes are unaffected (they read through the repository, which applies the filters), which is exactly why this hid — the aggregation is the one read path that bypasses the repository.

*Scope.* AND the applicable `contextFilters` into both direct-table paths (drizzle `where` and the mikro FilterQuery), honouring `ignoring <Cap>` bypasses the way the find path does (`mikroContextFilters(agg, bypass)` already takes the bypass set; drizzle has the equivalent). Gate it on a fixture with a `softDeletable` + `tenantOwned` source: a soft-deleted row and a foreign-tenant row must not be counted, and `ignoring` must still bypass. Runtime proof belongs on the tenancy leg (a count that includes another tenant's rows is exactly what `tenancy-e2e` exists to catch) — a generator pin alone would not prove the predicate BINDS.

**Three of four arms closed by [#2609](https://github.com/lemmit/Loc/pull/2609) (merged 2026-08-19).** The backends that build the direct-table WHERE themselves — node/drizzle, node/mikroorm (both through the shared hono v4 builder v5 reuses) and python — now AND in the source aggregate's capability filters, with `ignoring *` / `ignoring <Cap>` honoured exactly as on the repository arm and the ambient `requireCurrentUser()` / `require_current_user()` import body-scan-gated so an untenanted projection stays byte-identical. java and dotnet/efcore were **correct by construction** (`@SQLRestriction` on the entity / `HasQueryFilter`), and the new suite pins that too.

**Residue — the dapper raw-Npgsql aggregation arm**, left as reported follow-up by that PR: `persistence: dapper` writes its aggregation SQL by hand and has the same omission, so a `tenantOwned` source still counts every tenant's rows there and a `softDeletable` one still counts deleted rows. Same fixture shape closes it. Sibling of the 2026-08-24 generator review's §A1, which is the same omission crossed with `shape: document` on all five backends.

Sources: review thread on PR #2533; `src/platform/hono/v4/projection-query-routes-builder.ts` (`aggWheres` / the two `mikro` aggregation branches), `mikroContextFilters` in `src/generator/typescript/emit/mikroorm.ts`. Sibling of #2530 (dotnet document-shape tenant filter) — same class, different bypass.

## M-T6.26 — `= default` / required-input parity across create & update paths — `partial` · **S** · P2
*(Renumbered from the placeholder "M-T6.x" and re-statused 2026-08-05 — `landed` isn't a legend status. Create-path parity is done (below, #2377); the update-path halves landed via #2392 ("a default never relaxes an update" — Elixir enforced less than promised, Java rejected what it advertised); the remaining residue is fixed and awaiting merge as PR #2440 — Elixir accepts a PUT that omits a required field (presence is a deserialization question there too), with retro §80 (PR #2415, also awaiting merge) as its documentation twin.)*

Surfaced 2026-08-01 by the `audited` corpus fixture in the behavioral tier, not
by anything audit-specific.

A field declared with a default — `status: int = 0` — is treated as **optional
create input** on node (`z.coerce.number().int().default(0)`, so `POST` without
it succeeds) but the Elixir changeset still `validate_required`s it, so the same
request 422s with `{"pointer":"/status","message":"can't be blank"}`.

Same `.ddd`, same create call, different contract — a wire-level divergence the
per-PR compile gates cannot see (both backends compile fine) and which the
wire-golden differential misses because the request never reaches a comparable
response. It took a behavioral run on the elixir leg to expose it.

**Expected:** `= default` means "the client may omit this; the server supplies
the value" on every backend. Fix is in the Elixir changeset emission — a
defaulted field must be dropped from the required set.

Check the other three backends (python/java/dotnet) before closing: only node
and elixir were observed here, so the split may be wider than 1-vs-1.

**Landed.** The split was **4-vs-1**, not 1-vs-1: python (`status: int = 0`),
java (`RequiredSet("CreateThingRequest", ["name"])`) and dotnet
(`int Status = 0`) already agreed with node. Elixir was the sole outlier —
`changeset-emit.ts` derived its required set from `!f.optional`, ignoring both
the explicit `= default` and the bare-`bool` implicit default, while the IR had
already reified the rule as `CreateInputFieldIR.requiredInput`. Fixed by
consuming it (`isRequiredCreateInput`, now exported alongside a new
`isRequiredUpdateInput` for the PATCH seam).

> **Correction (2026-08-03).** The CREATE half of this is sound and
> runtime-proven. The UPDATE half shipped defective and the sentence that used
> to stand here — "an explicit default stays required and only the bool
> relaxation applies" — described the intent, not the code: `isRequiredUpdateInput`
> tested `hasImplicitDefault` (a *create*-input predicate) first, so it returned
> `false` for **any** `bool`, explicit default or not. `active: bool = true` came
> back omittable and Elixir's changeset stopped enforcing a field its own
> OpenApiSpex schema still advertised. #2392 (landed) fixed the predicate to
> `!isNullable(f)` — only optionality relaxes an update, which is RS-26 (#2329) —
> and found a sibling Java create-seam defect on the way (`emit/dto.ts` re-derived
> omittability as `f.optional || f.default != null`, missing the bare `bool`).
> The docstring, this entry and #2377's PR description all stated the rule
> correctly while one line of code did not; see `experience_gathered.md` §80.
>
> **Residual, still open** (re-verified on `main` after #2392 landed). It makes
> the emitted artifacts agree, but the
> cross-backend divergence survives it: `@update_required` is not enforcement on
> the update seam. Ecto's `validate_required` resolves through `get_field`,
> which falls back to the loaded row, so an omitted key is invisible — verified
> against real Ecto (`omit active+flag against a stored row → valid?=true`).
> Nothing upstream compensates (router is `plug :accepts, ["json"]`, no
> `OpenApiSpex.Plug.CastAndValidate`; the controller passes raw params through).
> A `PUT` omitting the field still answers **204 on Elixir, 422 on the other
> four**. Fixed in PR #2440 (awaiting merge): `update_changeset/2` checks
> presence against the raw attrs before `cast`, roughly where the create path
> already coalesces defaults, using `validate_required/2`'s own error shape so
> `ProblemDetails` still renders 422 `{"pointer":"/<field>"}` unchanged.
> Coverage measured across the corpus: 55 of 56 changesets take the check; the
> document aggregate (separate `cast_embed` emitter) is flagged, not claimed.

Two findings worth keeping:

- **The reported repro under-stated the fix.** `status: int = 0` alone did NOT
  422: a *literal* default is also emitted as the Ecto schema `default:`, so
  `%Agg{}` already carried it and `validate_required` passed by accident. The
  shapes that actually failed were the ones no schema default covers — a bare
  `bool` and an **enum-valued** default (`renderEctoDefault` returns null for
  both). Dropping them from `validate_required` is only half the fix; the
  column is `null: false`, so the changeset now also applies the declared value
  via a `__default/3` step after `cast` (which additionally covers an explicit
  `null` in the body). Server-sourced defaults (`now()`/`currentUser.*`) keep
  their existing controller-side params coalesce.
- **Why every gate was blind.** Compile tier: both backends build. Wire-golden
  differential: the request 422s before producing a comparable response. And
  the OpenAPI parity gate too — Elixir's own *spec* emitter already used the
  correct rule (`wireCreateDefault`), so the disagreement was between Elixir's
  published contract and Elixir's runtime enforcement, which no spec-vs-spec
  diff can see. New gate `test/conformance/create-required-parity.test.ts`
  therefore asserts each backend's **enforcement** surface (changeset / DTO /
  validator) against the canonical `requiredInput` set — verified to fail on
  the pre-fix emitter. `test/fixtures/corpus/audited.ddd` now OMITS the
  defaulted field from its `test e2e` create call, making the behavioral legs
  the runtime half of the same gate.

Not addressed (noted, out of scope): the emitted `change_<create>/1` helper
derives its required set from the create action's *params*, which for a
`crudish` aggregate do not carry the field-level `default` — so it still
over-requires. It has no caller in generated code (every write path goes
through `base_changeset`); threading defaults onto crudish create params would
ripple through every param-driven surface on all five backends.

## M-T6.35 — Persistence-adapter capability gaps — `open` · **M** · P2
The non-default persistence adapters reject shapes their EF/Ecto siblings accept: `loom.dapper-unsupported` (features Dapper does not emit), `loom.find-predicate-unsupported` (a find predicate the active adapter cannot lower), `loom.persistence-mode-unsupported` (a `persistedAs`/`shape` pair the adapter cannot store), `loom.saving-shape-unsupported` (a `shape(...)` the hosting backend cannot persist), `loom.vanilla-document-unsupported` (`shape: document` only partly emitted on Elixir), and — **inherited 2026-08-24 from the now-`done` M-T6.23** — `loom.mikroorm-unsupported`, whose only surviving raiser is the migration-chain one (`migration-checks.ts` `#migrations`: neither MikroORM's `orm.schema.updateSchema()` nor Dapper's boot-time `CREATE TABLE IF NOT EXISTS` can apply a declared migration step, so a rename resolves as DROP + ADD or silently never runs — the `loom.dapper-unsupported#migrations` twin is the same shape). The adapter axis is where "all targets support the whole surface" costs the most, because each adapter multiplies the matrix again — worth confirming per row whether the adapter *cannot* express the shape (a permanent limit, so a rename) or merely *does not yet* (a gap).
Sources: M-T9.27 register rows. Relates to M-T6.23 (mikroorm) and M-T6.25 (dapper query-time projections) — the same axis, already missioned.

## M-T6.36 — Java emitter shape gaps — `open` (rewritten 2026-08-31) · **M** · P1
**The two codes this mission was written about were PHANTOMS, and are gone.** `loom.java-projection-field-unsupported` and `loom.java-workflow-instance-field-unsupported` refused an ENTITY (containment-part) typed read-model field. Probing the premise before implementing showed there is nothing to implement: a part type resolves only inside its own aggregate (`src/language/ddd-scope.ts`), so `projection P { line: Line }` and `workflow W { line: Line }` both fail at phase ③ with `Could not resolve reference to NamedDecl named 'Line'` — on EVERY platform, before any java check runs. Two backend-named codes for a shape the LANGUAGE refuses: java read as uniquely limited, and the M-T9.27 register carried two rows nothing could ever drain. Both codes, their register rows, their catalogue entries and their census entries were deleted; the emitters keep their `guardInstanceField` / `guardProjectionField` throws as internal invariants, and `test/generator/java/generator-java-readmodel-gates.test.ts` now pins the unreachability AT THE SCOPE LAYER, so a widening of that rule fails a test instead of crashing codegen. `MAX_OPEN_GAPS` came down accordingly. (The VO-typed half of the original gap was already implemented by M-T6.4.)

**What the mission now owns** is the one REAL java shape gap, inherited from F2-ADP-7's java arm: `loom.java-reserved-identifier-unsupported`. A `.ddd` field / param / operation named after a **Java reserved word** (`case`, `do`, `new`, `int`, …) used to emit `String case;` / `public String case() {` / `record TicketResponse(String case, …)` — uncompilable Java, with zero diagnostics, so the failure surfaced only in a compile tier. It is now refused (java-hosted contexts only; the other four backends are untouched).

Draining it means EMITTING the name instead of refusing it, and the reason that is real work rather than a one-line escape is the language asymmetry the .NET arm hides: C# has verbatim identifiers, so `@case` is lexically `case` and the JSON property System.Text.Json derives is unchanged. Java has none (JLS §3.9), so the only escape is a rename — and a Java record component name IS the Jackson property name. So the fix is a mangled host identifier (`case_`, the spelling `escapeJavaIdent` already uses for LOCALS) **plus an explicit `@JsonProperty("case")` at every wire site**, applied consistently enough that no DTO is missed — a missed site is a silent wire divergence on java alone, which is strictly worse than the compile error. Delete the register row and lower `MAX_OPEN_GAPS` when it lands.
Sources: M-T9.27 register rows; the 2026-08-30 targets ledger rows `M-T6.36` (premise found stale) and `F2-ADP-7` (java arm).

## M-T6.48 — Malformed numeric input answers 500: four backends parse money with no guard, Elixir op-params skip `int` entirely — `partial` · **M** · P1

> **.NET arm LANDED 2026-08-31** (W1b `dotnet-adapters`, row `G2644-M-T6.48-numeric-ingress`). Both string-carried primitives are guarded at the one seam that produced them, `wireToCommandArgument` (`src/generator/dotnet/dto-mapping.ts`): `decimal.Parse` / `DateTime.Parse` became `TryParse ? v : throw new WireFormatException(<pointer>, …)` — `throw` is an expression in C# 7+ and `out var` declares into the enclosing block, so the guard fits the argument position the bare parse occupied and no emitter had to be restructured. A new `DomainExceptionFilter` arm renders node's envelope verbatim: **422**, `errors: [{ pointer: "/price", message: "Invalid decimal: \"12,50\"" }]`. The conversion function now REQUIRES its call site (`{ ns, pointer }`), so a new emitter cannot reintroduce a bare parse by omission; a value-object field reports the nested pointer (`/best/offer`). Compile-verified under `mcr.microsoft.com/dotnet/sdk:10.0` with `/warnaserror` — which is how the first attempt was caught: naming the property `Pointer` is CA1720 ("identifier contains type name"), an ERROR under that flag, hence `FieldPointer`. Pinned by `test/generator/dotnet/wire-numeric-ingress.test.ts`.
>
> **Still open:** java (`new BigDecimal` → NumberFormatException), python (`Decimal(str)` → InvalidOperation), elixir's `coerceOpParam` over `int`/`bool`, Java's float-as-int truncation, the stringified-number stance, and the cross-backend ingress conformance matrix. Those live in other packets' trees.

Found 2026-08-23 by the numeric-types audit ([F12](../audits/numeric-types-audit-2026-08-23.md)). One curl reproduces it: `{"price": "12,50"}` → .NET `decimal.Parse` `FormatException`, Java `new BigDecimal` `NumberFormatException`, Python `Decimal(str)` `InvalidOperation`, Elixir op-params `Decimal.new` raise — all **500**; only node (typed zod 400) and Elixir's create-changeset path (422) answer honestly. Elixir's `coerceOpParam` (`src/generator/elixir/vanilla/context-emit.ts`) coerces only money/decimal/datetime, so a non-integer `int` op param reaches `force_change` → `Ecto.ChangeError` 500 — the exact failure mode its own docstring documents for the money case it fixed. Java likely **silently truncates** `1.5 → 1` for int request fields (Jackson `ACCEPT_FLOAT_AS_INT` default, no coercion config emitted — verify with one POST, then pin strict). Stringified-number acceptance also skews across backends (`"5"` for an int: three accept, two reject).

**The fix:** wrap every bare money parse in a typed 4xx (mirror node's `moneySchema` regex + typed issue); complete `coerceOpParam` over int/bool; pin Java's float-as-int to strict rejection; pin one stance for stringified numbers (proposed: strict everywhere, matching node's body slot and .NET); probe the >1e21 exponential-money edge from the register annex.

**Verification when it lands.** A cross-backend ingress conformance matrix (bad money string, fractional int, stringified number, huge money) asserting the 4xx statuses per backend; one arm per backend mutation-proved.

Sources: [numeric-types-audit-2026-08-23](../audits/numeric-types-audit-2026-08-23.md) F12 + annex, plan.json N14. Relates to RS-15 (domain floor 422), M-T5.20 (denial ladder). Conflicts with M-T6.46/M-T6.47 in the shared wire files — stack or sequence within the wave.

## M-T6.50 — Python saga / workflow emission holes: three collector gaps that ship `F821` into the generated app — `open` · **S–M** · P1

Found 2026-08-30 re-verifying the [08-24 generator review](../audits/generator-code-review-2026-08-24.md)'s follow-up register (rows 14–16); two **reproduced** on `main` @ `aa236ae`, one latent. No ledger row in #2668, no other owner. One backend, one class — a renderer emits a name the module never binds — three sites:

1. **`dispatch-builder.ts` emits no domain-service imports at all.** `domainServiceImportLinesForWorkflow` exists (`python/emit/domain-service.ts:291`) and has exactly two callers — `workflows-builder.ts:257` and `emit/aggregate.ts:266`. The saga-handler file is not one of them, and the PY_TARGET leaf renders a domain-service call as the **bare** function name. Reproduced: a saga `on(s: ShipmentRequested)` handler calling `Retry.nextAttempt(1)` emits `next_attempt(1)` at `app/dispatch.py:31` with no `from app.domain.services.retry import next_attempt` → ruff `F821` / `NameError` at first delivery.
2. **Own-state assign in a non-correlated command workflow renders `self._x` at module level.** `workflows-builder.ts:582` builds the route target with `thisName: "self"`, and the `assign` arm (`:817-823`) renders the own-state LHS through that mapping — but the workflow ROUTE is a module-level `async def`, not a method. Reproduced: `create(title: string) { counter := 1 … }` emits `self._counter = 1` into `app/http/workflows_routes.py` → `F821`. (The correlated saga path is correct: it maps to the tracked row via `thisName: "state"`.)
3. **`collectStmtExprImports` misses `variant-match`.** `python/emit/domain-service.ts:243-265` enumerates 10 of the 11 `StmtIR` kinds by hand; nested statements inside a `variant-match` arm contribute no imports. Latent today, and it is §F3's exact shape — the two exported collectors in the *same file* already ride `walkStmtExprsDeep` / `walkWorkflowStmtExprsDeep` (`:283-296`).

**The work:** (1) call the existing helper from `dispatch-builder.ts` (the handler bodies are `WorkflowStmtIR`, so it is the `…ForWorkflow` variant); (2) decide the own-state target for the uncorrelated command shape — the honest options are a local dict the route saves at exit, or a validator refusal if own-state on an uncorrelated workflow has no meaning — and render *that*, not `self`; (3) delete the hand-enumerated switch in favour of the exhaustive walker (the `never`-guard is the point: the next new `StmtIR` kind fails to compile instead of silently emitting an unbound name).

**Verification when it lands.** Per-site generator tests plus a `ruff --select F821` run over the generated tree for each shape (the corpus python gate already runs ruff — the reason these shipped green is that no fixture crosses saga × domainService, or command-workflow × own-state; mint both). Mutation-prove by file-copy revert, per the repo rule.

Sources: [generator-code-review-2026-08-24](../audits/generator-code-review-2026-08-24.md) §Follow-up register (2026-08-30) rows 14–16; §F3 (one ref-walker per IR family) is the durable fix for (3). Relates to §A16 (the three sibling collectors #2667 already migrated onto `src/ir/util/walk.ts`).

## M-T6.51 — node document finds ignore `ignoring` — the A11 fix has no node twin — `open` · **S** · P1

Found 2026-08-30 (recorded as §D item 14 of the [08-24 review](../audits/generator-code-review-2026-08-24.md), re-verified on `main` @ `aa236ae`). Not claimed by #2668.

`documentFindMethod` computes the capability predicate once per aggregate — `const cap = documentCapabilityBody(agg, "x")` (`src/generator/typescript/repository-document-builder.ts:325`) — and reuses it for every find, with no access to that find's `bypassAll` / `bypassCaps`. So on a `shape: document` aggregate a declared `find … ignoring softDeletable` **still filters the soft-deleted rows out**: wrong data, fail-closed, no diagnostic. The synthesized query-time-projection reads assembled in the same file inherit it (`:89-90`), so a `projection … ignoring <Cap>` over a document source is likewise not bypassed on node.

Both siblings already do it right: elixir's `renderDocFindFn` threads `bypass: { bypassAll: f.bypassAll, bypassCaps: f.bypassCaps }` (`elixir/vanilla/document-emit.ts:641` — the §A11 fix landed in #2667), and python's document `findMethod` recomputes with the find's own bypass.

**The fix:** recompute the predicate per find, exactly as `renderDocFindFn` does — pass the find's bypass set into `documentCapabilityBody` (or a bypass-aware sibling) and drop the per-aggregate cache. Check the synthesized projection reads take the projection's own bypass, not the aggregate's default.

**Verification when it lands.** A generator test per shape (declared find with `ignoring <Cap>`, `ignoring *`, and a projection over a document source), asserting the bypassed predicate is *absent* — and mutation-proved, since the failure mode here is a silently-retained conjunct, which a presence-only assertion cannot see.

Sources: [generator-code-review-2026-08-24](../audits/generator-code-review-2026-08-24.md) §D item 14 + §Follow-up register (2026-08-30) row 18. Sibling of §A11 (elixir, fixed #2667).

## M-T6.52 — No backend can seed an event-sourced aggregate; three of five were wrong about it in two different ways — `open` · **M** · P1

Found 2026-08-30 by the targets-completeness audit (`F2-SEED-EVENTSOURCED`), gated 2026-08-31 by [#2700](https://github.com/lemmit/Loc/pull/2700). `seed default { Account { owner: "seeded-alice" } }` on an `persistedAs: eventLog` aggregate parsed `0 error(s), 0 warning(s)` and then diverged: **elixir** dropped the row from the dataset (`seedableAggs` filter, `src/generator/elixir/vanilla/seed-emit.ts:83/92`) and still committed the dataset's `mark_seeded` ship-once marker, so the rows could never be applied on a later boot; **java** and **.NET** built the create call from `forCreateInput(agg.fields)` — every declared field — against a factory that takes only the declared `create open(owner: string)` parameters, i.e. `Account.create("seeded-alice", null)` against `create(String owner)` (javac "cannot be applied", CS1739+CS1501). node/python were accidentally correct because their factories are keyword-shaped.

#2700 stopped the divergence with `loom.seed-event-sourced-unsupported` (`src/language/validators/seed.ts`) — all five now refuse identically instead of three diverging silently. **This mission is the feature the gate stands in for**, and the register row (`src/diagnostics/unsupported-register.ts`, `kind: "gap"`) drains only when it lands.

**The fix:** an event-append seed path. Elixir appends the aggregate's creation event through the same seam the create op uses rather than calling a repository `insert/1` that does not exist; java/.NET build the call from the aggregate's **declared `create` parameters**, not `forCreateInput` (the same divergence the .NET named-arg path already dodges by accident). Then delete the validator rule + its register row and lower `MAX_OPEN_GAPS`.

**Verification when it lands.** The `test/language/seed.test.ts` negative case flips to a positive one on all five; a behavioural leg that seeds a stream and reads the folded balance back; mutation-proved per backend.

Sources: [targets-completeness-2026-08-30](../audits/targets-completeness-2026-08-30.md) `F2-SEED-EVENTSOURCED`, ledger.json. Touches the seed emitters only — sequence against any other seed-path work.
