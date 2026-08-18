# T6 — Backend parity & generated-code quality

*The core matrix (CRUD/relational/ES/inheritance/audit/tenancy) is genuinely all-5 converged, and `backend-parity-gates.test.ts` ("gated xor emitted") is the strongest anti-rot seam in the repo. What's left is a short residue — but several residues have the WRONG failure mode (silent output or generator crash instead of an honest `loom.*` gate). Converting those is cheap and high-value.*

## M-T6.1 — Phoenix hosts SPA: wire the embed — `done` (PR #1886, verified 2026-07-13) · **L** · P1 ⭐ silent hole
Sources: [phoenix-surface-generator-wiring](../old/plans/phoenix-surface-generator-wiring.md) Phase 6, [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §6, D-PHOENIX-SURFACE.

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

## M-T6.4 — Java crash gates → honest validators, then implemented — `done` (PR #1879, verified 2026-07-13) · **S→M** · P1 ⭐ wrong failure mode
Sources: weak-spots §6, parity audit findings.

## M-T6.5 — Java `hosts:` fullstack embed (DEBT-14) — `done` (this session) · **M→S** · P3

## M-T6.6 — Python document filters — `done` (verified 2026-08-14) · **M** · P3
Both halves shipped. Non-principal: `supportsNonRelationalFilter` admits `(family === "python" && (shp === "document" || shp === "embedded"))` (`src/ir/validate/checks/system-checks.ts:2126-2129`), emitted by `documentCapabilityBody` (`src/generator/python/find-predicate.ts:557`) — the in-app blob filter node/java/.NET already had. Principal-on-document was **implemented**, not pinned: `supportsPrincipalNonRelationalFilter` (:2159-2160) admits python for `document` too, binding `current_user = require_current_user()` ahead of the list-comprehension filter (the DEBT-02 tail).
**Remaining cell is elixir, not python:** `supportsNonRelationalFilter` admits elixir for `embedded` only. Note elixir *does* support `shape: document` (plain Ecto's opaque `(id, data, version)` table + schemaless-changeset fold, :1447) — what it lacks is the in-app capability-filter evaluation over the rehydrated document. Folded into the vanilla-Phoenix residue (M-T6.2 / [vanilla-phoenix-gaps](../old/plans/vanilla-phoenix-gaps.md) §12).
Sources: parity register row 1, DEBT-02 residue.

## M-T6.7 — Node criterion filter leak — `done` (verified 2026-07-13) · —

## M-T6.8 — SYS-1: update-path wire validation — `done` (PR #1883, 2026-07-13) · —
Sources: [generated-code-review-2026-06-30](../audits/generated-code-review-2026-06-30.md) SYS-1.

## M-T6.9 — Adapter subsets: Dapper/MikroORM → FULL PARITY (drain) — `done` (9 waves, 2026-07-18/19) · **XL** · P3
Sources: DEBT-17/18, parity register adapter sub-matrix.

## M-T6.10 — Vanilla as a first-class adapter + `resolvePersistence()` — `done` · **M** · P3
Sources: global-plan T2.d, [platform-realization-axes](../old/proposals/platform-realization-axes.md) residue, M-T9.2 design doc.

## M-T6.11 — Reserved compose slots (was: `PlatformSurface` hooks, DEBT-27) — `blocked(T3/T4 features)` · — · P3
**Corrected 2026-08-14 — the five hooks this mission named do not exist.** `PlatformSurface` (`src/platform/surface.ts`) declares exactly one `emit*` method, `emitProject`; `emitAuthGate` / `emitCompliancePolicy` / `emitTenancyFilter` have zero occurrences anywhere in `src/`, and `emitAuditInit` / `emitI18nAdapter` survive only inside the doc comments of the slots below (a dangling reference worth scrubbing when someone next touches that file).
What is genuinely reserved-but-unwired is **three optional data slots on `ComposeServiceShape`**, undefined on every backend, which the compose orchestrator skips when absent: `auditSidecar` (a separate container draining audit-record events — M-T4.x audit), `policyInitCmd` (an entrypoint wrapper that loads/verifies compliance policies before the main service — M-T3.x authorization/compliance), and `i18nCatalogDir` (the in-container mount path for the i18n catalog — M-T1.11). Tenancy has no reservation at all: multi-tenant filtering ships through the capability/stance machinery ([`docs/tenancy.md`](../tenancy.md)), not a surface hook.
Disposition unchanged: don't build speculatively — each slot fills when its owning feature reaches emission. Tracked here so they aren't forgotten or cargo-culted.

## M-T6.12 — Provenanced wire pair — `open` · **M** · P3
Fold provenanced value+lineage into one `Provenanced<T> = {value, lineage}` carrier in `wireShape` so all targets agree (today 3 backends bolt on an extra key). Phases 1–6 incl. the `.value` read-site unwrap via one `ExprTarget` leaf.
Sources: [provenanced-wire-pair](../old/proposals/provenanced-wire-pair.md).

## M-T6.13 — OpenAPI tag grouping — `open` · **S–M** · P3
Doc-level `x-tagGroups` per served `api` across the five backends (design audited + simulated; resolve decision (f) on .NET/Java per-op tags first).
Sources: [api-openapi-tag-grouping](../old/proposals/api-openapi-tag-grouping.md), ddd-review api-grouping gap.

## M-T6.15 — Feliz silent-drop fallthroughs → implemented / honestly gated — `done` · **S→M** · P1 ⭐ wrong failure mode

## M-T6.16 — Honest gates for grammar-only surface — `done` (grammar-only-surface slice + angular/feliz backend-embed residual both landed) · **M** · P1

## M-T6.17 — Universal gate: instance-op `match await` needs a route id — `done` (this session) · **S** · P2 ⭐ wrong failure mode (JS frontends)
Sources: this session's Feliz async-effect harder-shapes work; `docs/actions.md` `match await`.

## M-T6.18 — Argument/parameter type-checking is systemically missing — `partial` (gap #1 constructions + gap #2 calls fully closed; gap #3 remains) · **L** · P1 ⭐ wrong failure mode (all targets)
An audit of every argument/parameter-passing call site (triggered by the `match await` arg gap, M-T6.17) found the AST type-system **defers arg arity/type checking** (`src/language/type-system.ts:742`) and `checkCallStmt` (`statements.ts:343`) only resolves the callee's *existence*, never compares `stmt.args` to its params.  So wrong arguments slip through at MOST call sites and mis-generate broken target code — caught only downstream by `tsc`/`gradle`/`mix`, **not by Loom**.  A `.ddd` that passes validation can emit code that doesn't compile.  **Checked today (good):** `emit Event { … }` (`checkEmit`, fully typed), `Action` on a param-op, `match await` args (M-T6.17), scalar intrinsics, `days(n)`, and the *arity* of `criterion`/`policy-fn`.  **Confirmed GAPS (each reproduced — generates broken code, zero Loom errors):**
1. **Record / VO / error / payload CONSTRUCTION** `Money { amount: "x", bogus: 3 }` — wrong field type, missing required field, AND unknown extra field all slip (`builder-call.ts` `checkBuilderCallType` resolves the type NAME but never the entries).  **Top severity** — every record literal in the language.  **Slice 1 landed** (#1966): `loom.unknown-construction-field` (`builder-call.ts` `checkConstructionFields`) rejects an entry naming a field the record (VO / entity part / record payload) doesn't declare — the zero-inference sub-check (unknown field NAME); zero false-positives across the whole example corpus.  **Slice 2 landed:** `loom.construction-field-type` (`statements.ts` `checkConstructionArgTypes` + `builder-call.ts` `recordFieldTypes`) type-checks each entry's VALUE against the declared field type for constructions reachable from an operation/create/destroy body — hooked into the statement walk (needs the lexical `Env`), mirroring `checkEmit`'s `unknown`-suppression + numeric-literal-promotion; full suite green, zero false-positives.  **Slice 3 landed:** the same `checkConstructionArgTypes` is now invoked at the non-body construction sites too — property defaults (`checkPropertyDefault`), `derived`/`invariant` bodies, and `function` bodies (expr + block form) in `types.ts` — so record field VALUES are type-checked at EVERY construction site.  **Slice 4 landed (completeness):** `loom.construction-missing-field` (`builder-call.ts` `checkConstructionFields`, beside the name check) rejects a construction that OMITS a required field — a declared non-optional, non-defaulted, non-`provenanced` `Property` (`contains` members auto-default empty, so they're never required); positional-entry constructions are skipped to stay conservative; full suite green, zero false-positives.  **The construction gap (name + value type + presence) is now closed** for VO / entity-part / record-payload builds.  Remaining: entry-value type-check inside page/workflow bodies (those walk their own env surfaces).
2. **Domain op / function / workflow-op calls** `bump("hi")`, `derived x = fee()`, `o.bump(a)` — arity + type unchecked.  **Slice A landed:** `loom.call-arg-count` / `loom.call-arg-type` (`statements.ts` `checkCallArgs`, wired into `checkCallStmt`'s bare + member branches) checks arity + per-arg type on every RESOLVED statement-level call, mirroring `checkEmit`'s `unknown`-suppression + numeric-literal-promotion; full suite green, zero false-positives.  **Slice B landed:** the EXPRESSION-position FREE calls (`derived x = fee(a)`, `let y := compute(a, b)`, `precondition check(a)`) — new `freeCallFunction` (type-system.ts, in lockstep with `typeOfFreeCall`) resolves a free call to its user `FunctionDecl` (undefined for VO ctors / criteria / policy-fns / duration builtins), and `checkExprCallArgs` (statements.ts) arg-checks those through the shared `checkCallArgs`, hooked at the statement walk + non-body sites; full suite green, zero false-positives.  **Slice B tail landed:** `checkExprCallArgs` now also covers EXPRESSION-position MEMBER calls (`derived t = price.scaled(f)`) via a running-receiver-type walk (`typeAfterSuffix` + `stepIntoNode`), which resolves a callee only for function/operation members of an entity/aggregate/VO receiver — so collection ops (`.sum`/`.count` on arrays) and scalar intrinsics are naturally skipped; full suite green, zero false-positives.  **Gap #2 is now fully closed** — every operation/function call (statement + expression, free + member) is arity- and type-checked.
3. **Workflow `create` field TYPES** (names checked, types not — `workflow-checks.ts`, IR-level so no lexical env); **UI component prop passing** `Panel(amount: "x")` (missing/extra/wrong-type, unchecked); **store action calls** `Cart.add(42)` (unchecked); **criterion/policy-fn arg TYPES** — **first slice landed:** `freeCallPredicate` (type-system.ts) + `checkArgTypesPositional` (statements.ts) type-check criterion/policy-fn calls at the env-bearing sites `checkExprCallArgs` already walks (bodies / preconditions / requires / derived / …); arity stays owned by `checkCriteria`/`checkPolicyFns` (type-only, no double report); full suite green.  Remaining: the `from X(args)` / `where:` / `when` criterion sites (own env surfaces), plus the component-prop / store-action / workflow-create-field-type items above.
   HIGH regression risk — the whole example/test corpus constructs records and calls ops, so any resolver bug false-positives broadly; land incrementally (start with #1), run the FULL suite each slice, mirror `checkEmit`'s `unknown`-suppression + numeric-literal-promotion (`canPromoteLiteralTo`) to avoid ergonomic false positives.
Sources: this session's parameter-passing validation audit (repros under the auditor's `/tmp/audit/`); `src/language/validators/{builder-call,statements,criterion,policy-fn}.ts`, `type-system.ts:742`, `src/ir/validate/checks/{ui-checks,workflow-checks}.ts`.

## M-T6.14 — Small parity leftovers — `open` · **S** · P3
DEBT-12 Phoenix `verify_token` niche; DEBT-08 `envelope` carrier (deferred — no live use; signpost via M-T5.9a); saga/projection EF `HasColumnName` correlation-column bug (from S7 Slice C review); domain-seam log-catalog §3 residue ⚠ partly stale.

## M-T6.19 — Java `shape: embedded` jsonb id-array reference collections — `done` · **M** · P3

## M-T6.20 — Elixir (vanilla Phoenix) `precondition` custom messages + wire `code` — `partial` · **M** · P3 ⭐ parity gap
The one remaining gap in the custom-validation-messages feature: a **`precondition`** on the vanilla Phoenix/Ecto backend carries neither its author `message "..."` nor the per-error wire `code`. Everything else shipped on all five backends (carriers + wire `code` + `loom.blank-message`); on the other four, op preconditions ride `preconditionsAsInvariants` into the wire validator and get message+code for free, but Elixir preconditions use a separate control-flow-error path with no slot for either. Full site map, mechanism, design options, and verification plan in the brief: [`missions/M-T6.20-elixir-precondition-messages-brief.md`](missions/M-T6.20-elixir-precondition-messages-brief.md).

**Path 1 (`ensure` → 422) — DONE, landed early as a side-effect of RS-15 (#2300).** Not planned work: the M-T9.11 wire-golden gate needed an error-envelope assertion, the golden is byte-exact, and elixir's bare `:precondition_failed` atom made the `detail` generic — so the message half of this path became the blocking dependency for closing that gate's last coverage hole. The denial reason is now the 2-tuple `{:precondition_failed, msg}` (and `{:forbidden, msg}`) exactly as the brief predicted, flowing through the existing `{:error, reason}` catch-alls unchanged; `src/generator/elixir/vanilla/denial.ts` owns both halves of the protocol so producers and consumers can't drift into shapes that miss each other. `denialMessage` honours the author `message "…"`, matching the other four. Pinned by `test/generator/domain-denial-detail-parity.test.ts` (all five, one shared literal) and by the wire golden at runtime.

**Path 2 (`raise` → prefix-routed `GUARD_RESCUE`) — STILL OPEN, and the brief's warning is now load-bearing.** `function` / `domainService` / pure-core bodies raise `ArgumentError` and `GUARD_RESCUE` routes them to 403/422 by **message prefix**. Swapping in the author text makes the prefix miss and `reraise` into a **500** — so this path deliberately still emits the derived `"Precondition failed: <source>"`, with a comment at each of the three raise sites saying why. This is the typed-exception (`defexception`) reshape, and it is what's left of the mission's message half. Sized **M** now rather than L: the ensure path (the larger half — ~6 producers, 4 consumers) is done, leaving 3 raise sites + `GUARD_RESCUE` + one emitted exception module, verified by `mix compile --warnings-as-errors` plus a fixture whose authored-message precondition must answer 422 and not 500.

**Wire `code` — untouched.** Still option (a)-vs-(b) per the brief. Independent of both paths above.

## M-T6.21 — Elixir (vanilla Phoenix) workflow: underscore unused `let` bindings — `open` · **S–M** · P3 ⭐ latent
A workflow `let x = <expr>` whose bound `x` is **never referenced downstream** (e.g. `examples/showcase.ddd`'s `resolveProject`: `let label = match outcome { … }` with no following use) lowers to a `with`-chain clause `x <- (<expr>)` that binds `x` and drops it — Elixir then emits `warning: variable "x" is unused`. Under `mix compile --warnings-as-errors` that's a hard failure. **Latent today:** the emitted compose Dockerfile runs plain `mix compile` (tolerates warnings), and the `--warnings-as-errors` gate (`elixir-vanilla-build.yml`) runs its own fixture set, which doesn't include a bound-but-unused `let` — so nothing currently gates on it. Surfaced while draining the docker-compose `parity` gate (once all five backends booted, the Phoenix container logged this warning under plain compile).

**Fix (the Elixir-idiomatic silence):** `_`-prefix a `let` binding whose name is unreferenced in the statements that follow it *and* the workflow return/output — exactly the move M-T6.15 already makes for an unused Feliz variant binder. The analysis helpers exist: `stmtUsesParam` (`src/generator/elixir/domain/predicates.ts`) + `collectWorkflowStmtParamRefsAll` (`workflow-execution-emit.ts`). Precompute the unused-binding name set once in `lowerStatements` (`workflow-execution-emit.ts:~1412`) and thread it into the per-statement renderer; the `expr-let`/`factory-let`/`repo-let`/`if-let` cases emit `_name` (or `{:ok, _name}` / `{:ok, _}`) when the name is in that set.

**Edge cases that make this S–M, not S:** (1) do **not** underscore the binding that fills the `with`-chain's final `{:ok, <result>}` result slot (the `bindName` logic) — that's the workflow's return; (2) preserve fallible-op success semantics — `{:ok, _} <- Context.create_…()` still gates the chain, only the value is discarded; (3) there are several clause-assembly sites (`workflow-execution-emit.ts:~224/~808/~1412`) so the unused-set must be threaded, not recomputed per site; (4) `assign` (`state <- …`) and emit clauses are never bindings to underscore.

**Verification:** a workflow fixture with a bound-but-unused `let` → `mix compile --warnings-as-errors` clean in the `hexpm/elixir` container (the gate that would otherwise trip); a generator test pinning the `_`-prefix (and that a *used* binding stays bare). Optionally add such a fixture to `elixir-vanilla-build.yml`'s `--warnings-as-errors` set so the class stays covered.

Sources: found 2026-07-20 while draining the compose `parity` gate (the .NET `global::` / Phoenix `def/3` / Python indent+`/metrics` chain). Related pattern: M-T6.15 (Feliz unused-binder → `_`).

## M-T6.41 — a direct-table aggregation applies NO capability `contextFilters` — on BOTH adapters · `open` · **M** · P2 ⭐ silent wrong answer
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

Sources: review thread on PR #2533; `src/platform/hono/v4/projection-query-routes-builder.ts` (`aggWheres` / the two `mikro` aggregation branches), `mikroContextFilters` in `src/generator/typescript/emit/mikroorm.ts`. Sibling of #2530 (dotnet document-shape tenant filter) — same class, different bypass.

## M-T6.23 — `persistence: mikroorm` non-persistence feature gaps — `done` (all 5 emitters landed; every gate deleted) · **M–L** · P2 ⭐ was silent
M-T6.9 drained the MikroORM adapter to full parity with drizzle on the **persistence** axis, and the validator's comment block said so without qualification. But **five non-persistence features are gated `&& !usingMikro` in the Hono emitter** and emitted *nothing*, with no diagnostic — a valid model generated a project with the feature simply absent and the CLI reported success:

| feature | file drizzle writes | mikroorm | now |
|---|---|---|---|
| query-time `projection` (`from … select …`) | `http/query-projections.ts` | **EMITS** (slice 4, PR #2533) | — |
| `timerSource` | `scheduler.ts` | **EMITS** (slice 3, PR #2525) | — |
| broker `channelSource` | `http/channels.ts` | **EMITS** (slice 2, PR #2524) | — |
| durable channel + local reactor | outbox + relay wiring | **EMITS** (slice 1, PR #2516) | — |
| realtime (`delivery: broadcast`) | `http/realtime.ts` | **EMITS** (slice 5, PR #2534) | — |

**Landed (gates, 2026-07-30):** all five are `loom.mikroorm-unsupported` diagnostics naming the omitted file and the way out (`src/ir/validate/checks/system-checks.ts`, `validateMikroOrmSupport`); `test/ir/mikroorm-feature-gates.test.ts` pins both directions per feature (mikroorm rejects, the same model on drizzle stays clean). Only R1 (the projection case) was on record — in [`integrity-audit-2026-07-residue.md`](../old/proposals/integrity-audit-2026-07-residue.md), which proposed exactly this interim; the other four were unrecorded.

**The realtime severity split** was the load-bearing design call *of the interim gate*, and it is **gone with the gap** (slice 5). For the record: a `broadcast` channel does double duty, and its *routing* half (what makes a projection fold or saga subscribe) always worked on this adapter. A frontend targeting the backend emits `src/api/realtime.ts` off the target's **platform**, not its persistence, so its EventSource would poll a 404 → **error**; with no such frontend the wire was unobserved and the fold/saga path intact → **warning**. Without that split the gate rejected working models (it broke 4 `test/adapters/` suites and 3 corpus features before the split). Worth keeping in mind for the *next* interim gate: severity is a function of who OBSERVES the missing thing, not of how broken the emitter is.

**All five emitters have landed** (slices 1–5, PRs #2516 / #2524 / #2525 / #2533 / #2534), and with the last clause deleted `validateMikroOrmSupport`'s **entire feature-gate family is gone** — `rejectFeature` itself is deleted, leaving only the one genuine SHAPE reject (an abstract inheritance base owning its own `contains`). The gate was always the interim; the emitters are the answer. `test/ir/mikroorm-feature-gates.test.ts` survives as the **ratchet**: every case now asserts EMISSION, so re-adding a clause — or re-gating an emitter on `!usingMikro` — turns it red.

**What the five slices actually cost, which is the transferable lesson.** Two were single-boolean deletions (broker channels, realtime SSE) because their emitters read no `db` at all; two were real ports (the outbox's capture/drain, the timer scheduler's watermark + `_xact_`-scoped advisory lock); one was a mixed port where three of four shapes needed a QueryBuilder and the fourth was already adapter-neutral. **An adapter gate written from "the emitter is `&& !usingMikro`-gated" says nothing about how much work the port is** — two of these had been hard ERRORS for two weeks and cost one boolean each. Read the emitter before sizing the gap.

**And every single slice's real bugs were found by BOOTING, not by compiling.** `em.nativeInsert` doesn't exist in v6; the saga Row was missing `lastEventId`; `<Ctx>EventRow.seq` made every event-sourced append fail `tsc`; a `date_trunc` key came back a string not a `Date`; MikroORM's result mapping renamed a `customer_id` alias and shipped the literal string `"undefined"`. Five bugs, five shapes, zero caught by a green compile.

**Slice 1 — outbox: DONE (PR #2516).** The adapter emits a `LoomOutboxRow` EntitySchema (`__loom_outbox`, `src/generator/typescript/emit/mikroorm.ts`) plus `createOutboxDispatcher` / `startOutboxRelay` over the EntityManager (`src/platform/hono/v4/workflow-builder.ts` — capture on a `fork({ keepTransactionContext: true }).insert`, drain on a fresh fork with `find` + `nativeUpdate`), and the `wireOutbox` / boot-relay / `index.ts`-import gates lost their `!usingMikro`. The validator clause is **deleted**; its `mikroorm-feature-gates` case flips to asserting the model generates, and emitter pins live in `test/adapters/node-mikroorm-outbox.test.ts`.

Two things the port surfaced that the gate hid. (1) The mikro **saga Row had no `lastEventId`** — the drizzle table adds it under a durable channel and the reactor preamble reads it, so the adapter could not have compiled this shape even with an outbox; it is emitted now, and the allocate literal spells `lastEventId: null` (the mikro state type is the Row CLASS, where a nullable property is still required — drizzle's `$inferInsert` makes it optional). (2) `em.nativeInsert` does not exist in MikroORM v6 (`em.insert` is the native insert); `tsc` on the generated project caught it — the compile tier, not a test.

*Evidence.* `tsc --noEmit` clean on the generated mikro project; **booted** against a real Postgres: `POST /orders` → `POST /orders/{id}/place` leaves exactly one `__loom_outbox` row (`type=OrderPlaced`, so capture replaced inline dispatch), the relay drains it (`dispatched_at` set, `attempts=0`), and the saga row lands with `last_event_id` = that row's id; forcing `dispatched_at = null` re-drains and the saga stays at one row (the idempotent-consumer marker no-ops the redelivery). Mutation-proved four ways: re-gating `wireOutbox`, dropping the outbox entity, dropping the `lastEventId` column, and re-adding the validator clause each turn the suites red (the last one reddens all 13 cases across both files).

**Slice 2 — broker channels: DONE (PR #2524, stacked on slice 1).** `emit.ts` computed `channelBindings` as `[]` for a mikroorm deployable, so `http/channels.ts` (driver + producer tee + consumer loop), the broker dependency and the boot-time transport wiring were all absent while compose still started the broker. Both gates deleted (`channelBindings`, `hasChannels`) plus the validator clause. The port was **almost free by construction, and that is the finding**: `src/generator/typescript/emit/channels.ts` reads no `db` at all — the transport is persistence-independent — and the two genuinely adapter-shaped pieces had already landed in slice 1 (the outbox the durable producer publishes through, and the hoisted shared `index.ts` import block). A gap that cost two deleted booleans had been an ERROR for two weeks; the lesson is that an adapter gate written from "the emitter is `&& !usingMikro`-gated" says nothing about how much work the port is.

*Evidence.* `tsc --noEmit` + `tsup` clean on the generated mikro project (rabbitmq producer fixture); `test/adapters/node-mikroorm-channels.test.ts` pins the module, the deps, the boot wiring, the durable-relay-in-RELAY-mode composition, and byte-equality of the transport module across adapters; **runtime** via a new `npm run test:channels-mikroorm` leg (the redis `channels-e2e` harness parametrized by `LOOM_CHANNELS_PERSISTENCE`, the `run-dapper.mjs` pattern) — the generated producer publishes a CloudEvents envelope to valkey, the consumer's loop receives it, spawns the correlated workflow instance and persists the Shipment **in a database the producer never touches**, all on `persistence: mikroorm`. Mutation-proved three ways (re-gate `hasChannels` → 5 cases fail; re-empty `channelBindings` → the same 5; re-add the validator clause → 7 across both files).

*Two CI facts fixed alongside.* (1) `channels-e2e.yml` had no `src/platform/**` in its `paths:`, so the file that owns the whole channel-transport wiring (`src/platform/hono/v4/emit.ts`) could not trigger the gate that tests it — added. (2) The new leg is a cell in the existing redis matrix (`backend: node-mikroorm`), not a new workflow, so no `local-run-mapping` row was needed; `docs/testing.md`'s channels row names the script anyway.

**Slice 3 — timers: DONE (PR #2525, stacked on slice 2).** `scheduler.ts` is the one emitted module whose database access is **not domain persistence** — a self-owned `loom_timer_runs` watermark and a `pg_try_advisory_xact_lock` — so this was a real port, not a deleted boolean. The five diverging call sites sit behind a `TimerStore` leaf table in `scheduler-builder.ts` (`db.execute(sql`…`)` + `{ rows }` vs `em.getConnection().execute(sql, params)` + a plain array); pg-boss is adapter-independent (it takes `DATABASE_URL`). The load-bearing detail: the advisory lock is `_xact_`-scoped, so its raw query is bound to the transaction explicitly via `tem.getTransactionContext()` — on a pooled connection the lock would end with that statement and single-fire would be silently lost.

*Evidence.* `tsc --noEmit` + `tsup` clean on both generated mikro projects (cron and `every:`). `test/adapters/node-mikroorm-timers.test.ts` pins the EntityManager signature, all four watermark statements, the tx-bound lock, the boot wiring, the cron-only deps, and the drizzle path staying byte-identical. **Runtime, booted** against a real Postgres: (cron) the watermark table is created and the first-boot baseline row inserted, then a `* * * * *` timer fires and the row advances 22:11:51 → 22:12:51, with the tick reaching the event-sourced reactor (one row in `orders_events`); (`every: 2s`) two replicas against ONE database tick and dispatch, persisting 178 correlated saga rows. Mutation-proved four ways: re-gating `hasTimers` (5 cases), dropping `getTransactionContext()` (the lock case), reverting the `seq` fix (its case), re-adding the validator clause (7 across both files).

*A boot-2 data-loss blocker, caught in review and fixed here.* `scheduler.ts` creates its `loom_timer_runs` watermark with raw `CREATE TABLE IF NOT EXISTS` — self-owned infrastructure, deliberately outside the domain MigrationsIR — and the mikro boot runs `orm.schema.updateSchema()`, which defaults to `dropTables: true` over an **unpruned** introspection. So from the SECOND boot onward the watermark was diffed as a removed table and dropped, then re-created empty by the scheduler in the same boot. The rows are the only reason it exists (the cron coalesce-once catch-up), so a restart silently wrote a fresh `now()` baseline instead of replaying the boundary missed during the downtime. Drizzle has no equivalent — `drizzle-kit migrate` never drops unknown tables — so it was an adapter divergence this slice introduced, and neither the emitter pins nor a single-boot runtime proof could see it.

Two independent guards, both kept: the watermark is now a real **entity** (gated on the same timer-ownership rule as `scheduler.ts`, with an invariant throw in `emit.ts` if the two rules ever disagree), and boot runs `updateSchema({ safe: true })` — which is what protects the tables no entity could cover, notably the first-boot seed marker `__loom_seed` (created the same raw way, so **this bug already reaches seed state on `main`**). Safe mode still creates missing tables and adds columns; it only refuses to destroy.

*Proved the way the bug bites — booted TWICE against one database, four variants:*

| variant | watermark rows survive boot 2 |
|---|---|
| pre-fix (no entity, no safe mode) | **NO** — sentinel row 0/1 |
| entity only | yes |
| safe mode only | yes |
| shipped (both) | yes |

Each half independently prevents the loss, which is why both stay: the entity makes the table part of the model, safe mode covers everything the model cannot describe. Mutation-proved at the emitter level too (dropping either guard reddens its pin).

**One part of the review's analysis did NOT reproduce**, and it is worth recording so nobody re-derives it from the comment: pg-boss's schema **survived** even in the pre-fix baseline (`pgboss` schema present, 12 tables intact, both boots). On this MikroORM version the drop pass did not reach a foreign namespace; only the public-schema non-entity table lost its rows. `safe: true` covers that case regardless, so the fix is unchanged — but the observed harm was watermark row loss, not schema destruction.

*A two-replica differential worth recording.* Both adapters were booted twice against one database: `every:` fires from **both** replicas (16/16 on drizzle, 13/10 on mikroorm, offsets ~0.4s, zero errors) — exact parity, and evidence that the emitter comment's "single-fire across replicas" over-claims for the `every:` path. `pg_try_advisory_xact_lock` only prevents a *concurrent* double-fire; two staggered ticks never contend. This is pre-existing and identical on both adapters (so not a slice-3 regression), but the wording should either change or the design should move to a leased/watermark check. Filed here rather than silently fixed, since it is a semantics decision.

*A tsc-tier hole found by this slice's compile proof (fixed here).* `persistence: mikroorm` + **any event-sourced** aggregate or workflow did not type-check: the generated `<Ctx>EventRow` declared `seq!: number` while every append omits it (it is a DB-generated `bigserial`), and MikroORM derives `RequiredEntityData` from the class — so `em.insert(…)` failed with "Property 'seq' is missing". **No gate hid this; the tiers did** — the corpus tsc gates run drizzle only, and the mikro behavioural leg builds with esbuild (no typecheck), so the `event-sourcing` / `eventsourced-workflow` corpus cases have been passing that leg while never being type-checked. `seq` is now optional; the runtime append is proven above. The structural hole (a mikro leg in the corpus tsc gate) is not closed here.

**Slice 4 — query-time projections: DONE (PR #2533, stacked on slice 3).** This was R1, the only one of the five already on record. Four shapes: the two aggregations push down through a mikro `createQueryBuilder` with `raw()` SQL fragments and a WHERE that reuses `whereToMikroFilter` (the same lowering every mikro find uses, rather than a second predicate→SQL renderer); the raw-table source (`from <Workflow>` / `from <Projection>`) reads its Row entity with `em.find(<Row>, <FilterQuery>)`; the repository-sourced one needed **nothing**, since `synthProjectionFinds` already synthesises the same `repo.<projName>()` find.

**A review caught the first version deleting the gate for all four shapes while porting only three.** The raw-table shape fell through to the drizzle arm and emitted `db.select().from(schema.…)` into an EntityManager file with no `schema` import — `TS2304`, a generate-then-broken-build, i.e. the *exact* silent class this mission exists to kill, reintroduced by the change that was closing it. No corpus fixture carries a workflow-/projection-sourced query projection, so the runtime leg stayed green. **The lesson is the ordering rule:** delete a feature gate in the same change that ports *every* shape the gate covered, and enumerate the shapes from the emitter's branches rather than from the ones the fixtures happen to exercise.

*Three runtime bugs the compile tier could not see, all found by booting.* (1) A computed grouping key (`startOfDay`) came back as the wire STRING, not a `Date` — drizzle gets a decoder from `.mapWith(<column>)`, a raw QueryBuilder select has none, so `(r.day as Date).toISOString()` compiled and threw `is not a function`; the mikro path now DECODES (`new Date(r.day as string)`). (2) MikroORM's default result mapping renames DB columns back to entity property names, silently rewriting any select alias that IS a column: a `customer_id` grouping key arrived as `customerId`, so the read of `r.customer_id` was undefined and the wire carried the string `"undefined"` — fixed with `execute("all", false)`. (3) Aggregate aliases were unaffected by (2) precisely because `avg_lines` is not a column, which is what made the bug look shape-specific rather than systemic.

*A gate that had to come WITH the emitter.* `validateFindPredicateAdapterSupport` walked repository finds, retrievals and capability filters — but never a query-time projection's `where`. On this adapter that mattered: a filter outside the FilterQuery subset would have made the aggregation run UNFILTERED and answer a plausible **wrong number**. It now walks projection filters for every adapter (`loom.find-predicate-unsupported`, naming the projection), which is what lets the emitter treat an unlowerable predicate as an internal contradiction instead of swallowing it.

*Evidence.* `tsc --noEmit` clean on both generated mikro projects (`projection-aggregation`, `projection-groupby`); booted against real Postgres, the filtered singleton answers `{orders:2, revenue:"42.5000", avgLines:3, biggest:"32.5000", smallest:"10.0000"}` over three rows of which one is excluded by the criterion, and both grouped routes answer correct buckets; `run-mikroorm.mjs projection-aggregation projection-groupby` — **both api-tier cases pass** (they were the two `MIKRO_SKIP` entries, now deleted). Mutation-proved five ways: re-gating the emit (4 cases), reverting the `mapResults` fix (1), reverting the key decode (1), removing the projection-filter gate (1), re-adding the feature clause (6 across both files).

*Coverage note, deliberately NOT acted on.* Neither `projection-aggregation` nor `projection-groupby` has a committed wire golden, so the cross-backend VALUE differential does not cover either feature on ANY backend — the mikro leg reports "0 cases compared". Capturing one from the node oracle would newly gate both features on the python/dotnet/java/elixir legs too, whose agreement I cannot verify from here; that is a wire-contract change for a reviewer to take deliberately, not a side effect of this slice. Both of this slice's bugs were caught by the api-tier assertions regardless.

**Slice 5 — realtime SSE: DONE (PR #2534, stacked on slice 4).** The last gate. `src/platform/hono/v4/realtime-builder.ts` reads **no `db`** (`realtimeTee(inner)` decorates a dispatcher; `realtimeRoutes()` takes no handle), so — like slice 2 — the port was deleting the gates: the file emit, the boot tee flag, `wireRealtime`, and the validator clause *including its consumer-dependent severity split*.

*Evidence.* `tsc --noEmit` clean on a generated mikro project carrying a broadcast channel + a folded projection + a react frontend; `test/adapters/node-mikroorm-realtime.test.ts` pins the module and its two exports, the tee composed OVER the projection fold (order matters — the fold runs, then the copy), the frontend's `EventSource` client, byte-equality with drizzle, and no diagnostic at either severity for both consumer shapes. **Runtime, BOOTED** against real Postgres: with the SSE stream open, `place()` delivers `event: OrderPlaced` + `{"type":"OrderPlaced","orderRef":"019ff4ff-…","at":"2026-08-12T08:03:47.922Z"}` to the connected client. Mutation-proved three ways: re-gating `wireRealtime` (the tee case), re-gating the file emit (4 cases across two files), re-adding the validator clause (5 cases across three files).

*Two test conversions this slice OWED, and paid.* (1) The `still WARNS about the realtime SSE wire (slice 5, not this one)` case added in slice 2 existed precisely so an earlier slice could not silently absorb the neighbouring gap — it flips here, in the PR that closed it. (2) `node-mikroorm.test.ts`'s saga pin asserted `events = createInProcessDispatcher(db)`, i.e. the ABSENCE of the tee — a drizzle-vs-mikro difference that only existed because realtime was gated off. It now pins the same fact in the teed form the default adapter already used.

**Hollow-cell note (feeds M-T9.8), corrected 2026-08-11.** The 2026-07-30 note claimed `channels-broker` and `outbox` were **passing** on the mikroorm behavioural leg with the feature absent. They were not passing — they were never **collected**: neither corpus fixture carries a `test e2e` block, so `featureCases` skips both on every backend, and the `MIKRO_SKIP` entries were silently **inert** (a register entry claiming a checked gap that nothing checks — hollower than the original diagnosis). `run-mikroorm.mjs` now ratchets its own register: a key naming no fixture fails the run, and a key whose fixture has no behavioural block prints `INERT` so the claim is visible. Giving `outbox.ddd` / `channels-broker.ddd` real `test e2e` blocks is its own mission-sized change (it arms five backend legs + the wire golden at once, like #2468) — **not** folded into slice 1, whose runtime proof is the booted check above.

Sources: found 2026-07-30 auditing the archived proposal corpus for unmapped work (R1 was the thread that led to the other four). Gate reproduced as a silent drop first (generate on mikroorm vs drizzle, file trees diffed), then as a diagnostic.

## M-T6.22 — Drain the M-T9.11 differential findings (RS-11/RS-12) — `done` (2026-07-28) · **M** · P2

## M-T6.24 — Elixir: the two remaining untyped denial edges — `done` · **S** · P3 ⭐ one is an info leak
**DONE (2026-08-01).** Both residues closed. (1) the untyped `{:error, reason}` tail now answers a sanitized **500 + `"internal"`** instead of 400 + `inspect(reason)`, via a shared `respondErrorTail` in `denial.ts`; `_reason` is bound underscore-prefixed because a plain `reason` is an unused variable under `--warnings-as-errors`. (2) `dispatch-emit.ts`'s `requires` no longer throws a bare `:forbidden` atom — **the catch site was checked first and there isn't one** (the throw propagates out of the reactor's `handle/1`, which the Dispatcher calls untrapped), so neither the atom nor its `precondition` sibling's bare string was ever matched on, and both could be unified onto `denialTerm`. Minted as **RS-26**, gated by `test/conformance/internal-fault-parity.test.ts` on all five. Verified by `mix compile --warnings-as-errors` on ten fixtures.

A **second, larger divergence** surfaced while writing that gate — filed as M-T6.25 below.
Two small, independent residues left after #2300 centralised the vanilla Phoenix denial protocol in `src/generator/elixir/vanilla/denial.ts`. Both are cases the tuple reshape did **not** reach, found by grepping the protocol's edges rather than by a failing test — so nothing currently gates either.

**(1) The untyped `{:error, reason}` fallback answers 400 and `inspect/1`s the term.** The generated `respond/2` renderers (`explicit-handlers-emit.ts`, `workflow-execution-emit.ts`) end with

```elixir
def respond(conn, {:error, reason}),
  do: ProblemDetails.problem_response(conn, 400, "Bad Request", inspect(reason))
```

Two problems. **Status:** an *unrecognised* error term is by definition not a client error — the other four backends map an unhandled fault to a sanitized **500** (`problem(500, "Internal Server Error", "internal")` on Hono, the same on .NET/Java/Python). Answering 400 tells the caller to fix their request when the server is what went wrong, and it survived RS-15's sweep precisely because it is *not* the domain floor. **Leak:** `inspect(reason)` renders an arbitrary internal Elixir term — struct names, module paths, whatever the failing call returned — straight into a public `detail`. The other four deliberately send the fixed string `"internal"` for this arm. Worth minting as an RS-rule (`conformance-semantics.md`) when fixed, since it is a genuine cross-backend runtime divergence the wire golden can't see today (no shared system reaches this arm).

**(2) `dispatch-emit.ts`'s `requires` throws a bare atom.** At `src/generator/elixir/dispatch-emit.ts:~1007` a reactor/starter-body `requires` emits `throw({:error, :forbidden})` while its `precondition` sibling four lines above throws the full `"Precondition failed: <source>"` string — inconsistent inside one function, and the atom means any 403 from a dispatch body has no `detail`. This is a `throw`, not the `with`/`ensure` mechanism, so it was out of scope for the denial-tuple reshape; check the catch site before changing the shape.

Neither is reachable from a shared behavioural system today, which is why the per-PR wire gate is green on both — they need a fixture to be gated, not just a fix.

Sources: found 2026-07-29 while landing RS-15 (#2300). Related: M-T6.20 (the `raise`-path half of the same protocol), M-T5.20 (routing the ladder through `resolveErrorStatus`).

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

## M-T6.29 — `persistence: dapper`: the `deny` authz sentinel crashes codegen, and the write scope is absent — `done` · **S–M** · P2 ⭐ security-adjacent

Found by `test/fixtures/corpus/policy-deny.ddd` the moment it joined the corpus (the fixture's own PR): the dotnet compile tier runs BOTH persistence adapters, and `deny` had never been through either.

Two halves, both in `src/generator/dotnet/emit/dapper.ts`:

- **Read.** `whereToSql` has no `authz-filter` case, so the `deny` sentinel falls to its `default:` and the emitter throws — `dapper: capability filter on 'Secret' is outside the Dapper SQL subset`. The fragment itself is trivial (`1 = 0`), so this is a 3-line arm.
- **Write.** `writeScopeFilter` is not read by `dapper.ts` at all, while the EF repository emitter honours it and the SHARED command layer (`cqrs/commands.ts`) already dispatches to `GetByIdForWriteAsync` whenever an aggregate carries one. So the write half is not merely unrendered — the command layer calls a method the Dapper repository never emits.

**Do not land the read arm alone.** It would turn the corpus fixture green while `deny write on` stayed unenforceable — a hollow cell of exactly the kind M-T9.8 sweeps for. Land both, or gate the pair honestly in `validateDapperSupport` (`loom.dapper-unsupported`) and move the fixture from `DAPPER_COMPILE_SKIP` to `DAPPER_UNSUPPORTED`. Note the asymmetry that makes this a crash rather than a boundary today: `tenancy-hierarchy`'s scope sentinel IS rejected by the validator; the deny sentinel escapes it.

Sibling of M-T6.23 (the same class on the node/mikroorm adapter) and M-T6.25 (the other dapper compile-tier gap). Adapter-axis gaps like this are invisible to the "five backends" framing — the persistence adapter is a second axis.
Sources: `test/e2e/corpus-dotnet-dapper-build.test.ts` (`DAPPER_COMPILE_SKIP.policy-deny`), `src/generator/dotnet/emit/dapper.ts`, [authorization-phase4-deny](../old/plans/authorization-phase4-deny.md).

**Done (PR #2492).** Both halves landed on `src/generator/dotnet/emit/dapper.ts`, not one:
`whereToSql` gained an `authz-filter` arm (`authzFilterToSql`, discriminated so a future
`AuthzFilterKind` is a `tsc` error rather than a fall-through), and the relational Dapper
repository now reads `writeScopeFilter` and emits `GetByIdForWriteAsync` — a
`SELECT EXISTS` write-scope pre-guard with the READ `filterSql` spliced in (EF gets that
from `HasQueryFilter` free; without it the Dapper write scope would be *wider* than the
read scope). `DAPPER_COMPILE_SKIP.policy-deny` deleted, ratchet `max` 3 → 2.

*Evidence.* (1) Compile: `dotnet build /warnaserror` clean on the generated `policy-deny`
project under `persistence: dapper` (`mcr.microsoft.com/dotnet/sdk:10.0`). (2) Emitters:
`test/generator/policy-deny.test.ts` gained a Dapper leg pinning `1 = 0` at **every** read
site (GetById / FindManyByIds / findAll page + its COUNT / the author's own named find)
plus the write guard, and pinning the control aggregate untouched. (3) **Runtime, booted**
(the compile tier cannot see whether the value binds — §81): against a real Postgres, a
`deny`-read row present in the table (`select count(*) from secrets` → 1) answers `GET/{id}`
404, `findAll` `total=0` and the named find `[]`, while the control returns its row; a
`deny write` aggregate reads 200 but `update`/`destroy` 404 with the balance unchanged at
100, while the control's update returns 204 and moves to 999. (4) **Mutation-proved**, three
ways: dropping only the write method → `CS0535: 'AccountRepository' does not implement
'IAccountRepository.GetByIdForWriteAsync'`; dropping the read arm → the original codegen
throw returns; flipping the fragment to `1 = 1` → the generator test fails **and** all four
booted assertions invert (404→200, total 0→1, 404→204, balance 100→999).

**Bonus — a stale `DAPPER_UNSUPPORTED` claim, verified false.** That map asserted
`tenancy-hierarchy` was rejected by `loom.dapper-unsupported`. It was not: the deep-scope
sentinel escaped `validateDapperSupport` exactly as the deny sentinel did, and the fixture
crashed with the *same* "outside the Dapper SQL subset" throw. `validateDapperSupport` now
gates it for real, under a dedicated `loom.dapper-unsupported#deep-scope` catalog message —
the generic tail claims every surviving Dapper reject has no relational mapping on *any*
adapter, which is untrue here (efcore renders it fine; what Dapper lacks is the
principal-param binding for the sentinel's `currentUser.<claim>` sub-expressions).
Pinned by `test/adapters/dotnet-dapper.test.ts`.

**Known residue (pre-existing, not introduced here).** `GetByIdForWriteAsync` is emitted by
the RELATIONAL repository emitter only — on **both** adapters. A `shape: document` or
`persistedAs: eventLog` aggregate carrying a `writeScopeFilter` would have the interface
declare a method neither `repository.ts` nor `dapper.ts` implements. No fixture reaches it;
worth a mission if one ever does.

## M-T6.25 — `persistence: dapper`: query-time projections are EF-coupled — `done` (2026-08-16) · **M** · P2 ⭐ two shapes silent

Four of the five query-time projection handler shapes inject `AppDbContext` and
run EF LINQ, so a `persistence: dapper` deployable that declares one does not
compile: `CS0234: 'EntityFrameworkCore' does not exist in the namespace
'Microsoft'`. The `.ddd` parses, the project generates, and it breaks only at
`dotnet build` — invisible to a generation-tier gate.

**Scope is wider than the ratchet suggests.** Measured by emitting every corpus
feature under `persistence: dapper` and compiling it (36 → 35 generate → 33
compile):

| shape | data path | dapper | coverage |
|---|---|---|---|
| per-row (`select` over an aggregate) | `IOrderRepository.<Proj>()` | ✅ already neutral | — |
| whole-table aggregation | `AppDbContext` | ❌ CS0234 | `DAPPER_COMPILE_SKIP` |
| grouped aggregation (`group by`) | `AppDbContext` | ❌ CS0234 | `DAPPER_COMPILE_SKIP` |
| workflow-sourced (`from <Workflow>`) | `AppDbContext` | ❌ **untested** | none |
| projection-sourced (`from <Projection>`) | `AppDbContext` | ❌ **untested** | none |

The per-row shape routes through the repository and is persistence-neutral
already — worth knowing, because it means this is not "port the projection
emitter", it is "port the four shapes that bypass the repository". The last two
are the ones a reader would miss: no corpus fixture exercises them, so they are
silently broken rather than ratcheted, and **a fixture for each is the first
slice** — the fix needs a witness before it needs an implementation.

**Design decisions (owner, 2026-08-03).**

1. **Extend `src/generator/sql-pg-expr.ts`** rather than write a second SQL
   expression renderer. It is 120 lines (literals / refs / paren / unary /
   binary / ternary), throws on anything else, and is already backed by a
   validate-time predicate. Two hand-maintained copies of one translation is
   exactly how the `audit_records` nullability drifted (§67-68,
   `util/audit-records-table.ts`). Widening it touches the migration backfill
   path too, which is covered by `schema-load` + `migration-evolution`.
2. **Reject out-of-subset `where` at validate time** — a
   `loom.dapper-unsupported` diagnostic naming the projection and the offending
   expression, consistent with how `tenancy-hierarchy` is already refused on
   this adapter. NOT an in-memory fallback: for an aggregation projection that
   materialises the whole table to produce one integer, which is precisely the
   scaling failure the shape exists to avoid (`projection-aggregation.ddd`'s own
   header says so). A silent perf cliff is worse than a diagnostic.

**Implementation notes** (gathered while scoping; make this mechanical):

- The idiom is already in the tree — `projection-emit.ts` branches on a
  `usingDapper` flag and swaps `AppDbContext` for `NpgsqlDataSource`, reading
  through `conn.QueryAsync<TDbRow>(new CommandDefinition("SELECT …"))` with a
  private `<T>DbRow` + `Map<T>` pair. `emitQueryProjections` takes no such flag
  today; thread it from `index.ts`, which already knows.
- **Cast in SQL so the existing coercion path is reused verbatim.** `csCoerce`
  reads `agg?.<Field>` and already handles count / money-as-string / declared-
  type casts. If the Dapper row class exposes the same property names and the
  SQL casts to the CLR types EF produced — `COUNT(*)::int` (Postgres COUNT is
  bigint → `long`, and the row field is `int`) — then `csAggregate`'s siblings
  need no Dapper twin and the two arms cannot drift.
- Table naming under Dapper is `plural(snake(aggName))`, unqualified
  (`tableOf` in `emit/dapper.ts`); columns are `snake(field)`.
- Grouped needs `GROUP BY <keys>` **and** `ORDER BY <keys>` — the EF arm's
  comment is explicit that without the ORDER BY the group order is
  engine-chosen and the M-T9.11 wire differential flakes on row order.

**Verification.** Drop the two `DAPPER_COMPILE_SKIP` entries in
`test/e2e/corpus-dotnet-dapper-build.test.ts` and lower its `allowlist-ratchet`
`max` 2 → 0 in the same PR; add corpus fixtures for the workflow-sourced and
projection-sourced shapes first, so their port has a gate. `dotnet build
/warnaserror` in `mcr.microsoft.com/dotnet/sdk:10.0` is the compile proof;
`behavioral-dapper` is the runtime one.

**Sources:** #2394 (the gate that found it), `corpus-dotnet-dapper-build.test.ts`,
`dapper-projection-emission.test.ts` (the folded-read precedent this follows).
Worked around in `test/fixtures/corpus/audited.ddd` by passing the field
explicitly, with a comment pointing here — deliberately NOT worked around in the
compiler.

### Outcome (2026-08-16)

All four direct-table arms are raw Npgsql; `DAPPER_UNSUPPORTED` went **5 → 1**
(`tenancy-hierarchy`, the only remaining boundary with a witness) and
`DAPPER_COMPILE_SKIP` stayed at its 0 floor with the debt behind it paid.
`read-gates`, `projection-aggregation`, `projection-groupby` and
`projection-join` all generate, compile `/warnaserror`, and — verified by
running the emitted SQL against a real Postgres — return the values their
`test e2e` blocks assert.

**One design decision changed.** Decision 1 above nominated
`src/generator/sql-pg-expr.ts` as the predicate renderer to widen. The
implementation uses **`whereToSql` (`emit/dapper.ts`)** instead, for the same
"don't write a second one" reason pointed at a different existing renderer:
`sql-pg-expr.ts` is the MIGRATION-BACKFILL renderer, which nothing on the Dapper
runtime path uses, whereas `whereToSql` is the lowering every Dapper find,
retrieval and capability filter already goes through. Reusing it means a
projection `where` and a find `where` over the same predicate emit byte-identical
SQL — which is the property decision 1 was actually after. Decision 2 (reject
out-of-subset at validate time, never an in-memory fallback) stands, and is
carried by the pre-existing `DAPPER_SUBSET` descriptor plus the narrowed
`dapperQueryProjectionGap`.

The workflow-sourced and projection-sourced arms were ported without first
minting the corpus fixtures the scoping note asked for — they are pinned by
`test/generator/dotnet/dapper-query-projection-emission.test.ts` and by the fact
that both read a store this adapter itself emits (so their columns are known),
but a runtime witness for each is still owed and belongs with M-T9.x.

**Found while landing it:** M-T6.42 below — the Dapper adapter emits UNQUOTED
identifiers, so a reserved-word column name makes its DDL a syntax error.

## M-T6.30 — Vanilla Phoenix has no app-global RFC 7807 arm — `open` · **M** · P2 ⭐ shape divergence, not a detail one
Found 2026-08-01 while writing RS-26's five-way gate, and it is **bigger than the rule that surfaced it**.

The four non-elixir backends install an **app-global** unhandled-exception handler — `app.onError` (hono), `DomainExceptionFilter` (.NET), `ApiExceptionAdvice` (java), `install_error_handlers` (python) — so *any* unmodelled fault, on any route, in any system, answers the RFC 7807 envelope.

Vanilla Phoenix's sanitized arm exists **only** in the `respond/2` dispatchers that `workflow-execution-emit` / `explicit-handlers-emit` render. **A plain CRUD system emits none at all**, and an unhandled exception falls through to Phoenix's stock `ErrorJSON`:

```elixir
%{errors: %{detail: Phoenix.Controller.status_message_from_template(template)}}
```

That is a **different SHAPE, not a different detail**: `{"errors":{"detail":"Internal Server Error"}}` against the other four's `{"type","title","status","detail","instance"}`. A client that parses 7807 gets nothing it can read — so this is a contract break, not a cosmetic one, and it applies to the *most common* system shape (CRUD with no workflow).

**Why no gate sees it.** The M-T9.11 wire golden can't: no shared fixture reaches an unmodelled fault (every error they produce is modelled). `conformance-parity` can't: the spec-diff compares *declared* responses, and this is a runtime fallback nobody declares. RS-26's static gate deliberately shapes its fixture *around* the gap (it carries a workflow) rather than failing on it, with the reason written at the bottom of `test/conformance/internal-fault-parity.test.ts`.

**The work:** give the generated Phoenix app a 7807-shaped error view + `application/problem+json` content-type at the shell level (`src/generator/elixir/vanilla/shell-emit.ts`, `renderVanillaErrorJson`), so the app-global fallback matches the four. Check the `404`/`400` templates at the same time — `ErrorJSON` handles every un-rescued status, not just 500, so the same shape divergence likely applies to a bare unmatched route.

**Verification:** extend `internal-fault-parity.test.ts` to the plain-CRUD fixture (drop the workflow) once closed — the test is written so that is a one-line change. A booted check is better still: hit a route that raises on the generated Phoenix app and read the body.

Sources: found while landing M-T6.24 / RS-26. Relates to RS-22 (the 7807 envelope's exact membership) and M-T9.11 (which is blind here).

## M-T6.31 — The absent-read 404 is three different envelopes — `done` · **M** · P1 ⭐ the RS-28 companion, and the half a string fix can't reach
Found 2026-08-02 by the M-T9.25 casing/absence census sweep, and it is the **structural** half of what RS-28 fixed as a string.

**Closed by [#2520](https://github.com/lemmit/Loc/pull/2520)** (the by-id + `T?` / `T option` arms had already landed with RS-27 and the 2026-08-05 caller-census drain; #2520 took the two read sites those left behind). Evidence:

- **dotnet** — projection show ×2 (EF + Dapper, `src/generator/dotnet/projection-emit.ts`) and workflow-instance show ×4 (ES/state × EF/Dapper, `src/generator/dotnet/workflow-emit.ts`) now `throw new AggregateNotFoundException($"<Resource> {key} not found")` through the shared `dotnetNotFoundThrow` helper, so `DomainExceptionFilter` renders every 404 in the app. No `NotFound()` remains in either controller.
- **java** — projection show (`src/generator/java/emit/projection-reads.ts`) and workflow-instance show ×2 (`src/generator/java/emit/workflow-instances.ts`) `orElseThrow`/`throw` the same carrier, so `ApiExceptionAdvice.onNotFound` renders it. No `ResponseEntity.notFound().build()` remains.
- **elixir** — a THIRD divergence the mission had not recorded: its workflow-instance 404 said `"<Wf> instance <id> not found"` where node/python said `"<Wf> <id> not found"`. Aligned on the node/python spelling (the reviewed RS-27 extension recorded in `workflow-builder.ts`), so the sentence is now byte-identical on all five.
- **node** — needed the M-T6.28 root floor below: its folded-projection show raised the right carrier into a router with NO `onError`, and the root handler carried only framework arms, so the miss answered **500 `"internal"`**. Proven at runtime, both directions (see M-T6.28).
- Gates: `test/conformance/absent-read-envelope-parity.test.ts` (per-SITE, file-scoped, five backends, positive + negative per arm; each of the six emitter fixes mutation-proven to fail exactly its own case) plus a new **absent-read wire-golden probe** (`test/behavioral/wire-differential.mjs`) that re-requests each projection-show / instance-show URL the tier hit with an impossible key — `wire-golden/projection.json` gained the 404 entry, so the envelope is now gated on every booted leg.

**Left open, recorded here rather than folded in silently:** `GET /files/{key}`'s absent-object 404 is a **fourth** shape and *none* of the five backends answers 7807 — node/python/elixir send `{"error":"not found"}` as `application/json` (`src/generator/typescript/emit/routes.ts`, `python/files-routes-builder.ts`, `elixir/vanilla/files-controller-emit.ts`), dotnet/java send an empty-bodied 404 (`emit/program.ts` on both). It is not one of this mission's named read sites and converting it is a wire change on three backends, so it wants its own claim.

RS-28 made every backend's 404 `detail` name its resource. That is necessary and not sufficient, because two backends don't emit the envelope RS-28 assumes on their READ paths at all:

| backend | absent `GET /<agg>/{id}` (and `T?` / `T option` / projection show / workflow-instance show) |
|---|---|
| node, python, elixir | full RFC 7807 — `type` `title` `status` `detail` `instance` |
| **dotnet** | `NotFound()` → ASP.NET's `ProblemDetailsFactory` shape: rfc9110 `type`, **no `detail`, no `instance`**, plus a `traceId` extension no other backend sends |
| **java** | `ResponseEntity.notFound().build()` → **404 with an EMPTY body and no content-type** |

**Both are also intra-backend splits**, which is what makes this M-T9.25's class rather than an ordinary parity gap — each of those two backends already emits the *correct* envelope on its command path, from a hand-built handler, and then contradicts itself on five read sites:

- **.NET** — `Api/DomainExceptionFilter.cs` builds the problem by hand, and `src/generator/dotnet/emit/api.ts` carries a comment explaining that `ControllerBase.Problem(...)` is deliberately avoided *because* the factory "leaves `instance` null and injects a `traceId` extension no other backend sends". That reasoning was applied to one arm. Five siblings still call `NotFound()` and route straight through the factory it names. Nothing in `Program.cs` sets `SuppressMapClientErrors`.
- **Java** — `ApiExceptionAdvice.onNotFound` emits `application/problem+json` with the full envelope; five sibling read sites return `ResponseEntity.notFound().build()`.

**Corroborating evidence this is real and was never reviewed:** `test/behavioral/response-diff.ts` already carries a normalizer rule for a `traceId` key — and **no backend but .NET can produce one**. A normalizer exists for a divergence no waiver records, because no golden reaches a plain 404.

**The work.** Make the read paths raise the same carrier the command path does (`AggregateNotFoundException` on both), so the one hand-built handler answers every 404 in the app — rather than adding a second construction site. ~5 sites per backend; the carrier and the handler arm both already exist.

**Verification.** The cheap gate is a fixture-level assertion that no read site emits `NotFound()` / `notFound().build()`. The real one is a **golden that exercises `GET /<agg>/{id}` against a missing id** — the wire-golden set has 31 entries and not one reaches a plain 404 (all four of its error entries are declared-error variants ×2, a 409 and a 422), which is precisely why this survived. That golden would gate RS-28's string *and* this envelope forever at zero new CI boot cost.

Sources: M-T9.25 census sweep 3 (casing/absence). Relates to RS-28 (the string half, already fixed), M-T6.25 (the same "one backend, two envelope shapes" defect on elixir's 500), M-T9.11 (blind here for the coverage reason above).

## M-T6.27 — Elixir's named-operation path has no optimistic lock — `done` (PR #2505, merged 2026-08-11) · **M** · P1
All three op write paths (context named-op, returning-op, document op) now ride `Ecto.Changeset.optimistic_lock(:version)`; `persist_change/1` rescues `Ecto.StaleEntryError -> {:error, :conflict}`; the op controller + returning-op mapper answer 409 via `conflict_response/1` (gated on `versioned`). Same +1 bump, so RS-14's wire values unchanged — no golden moved. Gate: `test/generator/elixir/vanilla-named-op-optimistic-lock.test.ts`, mutation-proven 4/4; real `mix compile --warnings-as-errors` on the three affected corpus shapes. Deliberately out of scope (recorded in #2505): a raced op behind a workflow/explicit-handler `respond/2` answers the sanitized 500 tail, the ladder-width class M-T6.28 tracks; the two-writer behavioural case remains the honest runtime gate (M-T9.3).
Sources: M-T9.25 census sweep 3 (409/500); PR #2505.

## M-T6.28 — Node's error ladder: the root floor and the 409 arms — `done` (#2520) · **M** · P2 ⭐ the node twin of M-T6.29
Found 2026-08-02 by the M-T9.25 409/500 census sweep.

**Closed by [#2520](https://github.com/lemmit/Loc/pull/2520)** — in two halves, matching the two consequences below (consequence 1's FRAMEWORK arms had landed in #2485; the domain arms had not). Evidence:

- **The root floor now carries the DOMAIN ladder** (`src/generator/typescript/emit/routes.ts`): `ForbiddenError` / `DisallowedError` / `DomainError` / `AggregateNotFoundError` / SQLSTATE `23505` / `ConcurrencyError` / `ExternHandlerError`, at the same statuses and with the same `recordDomainFault` counters the per-router ladders use, resolved through the api's `httpStatus` map (so an override moves the floor too) and presence-gated on `unique`/`versioned` exactly as the per-router arms are. So `http/projections.ts` and `http/realtime.ts` — both bare `new OpenAPIHono()`, no `onError` — inherit a real floor. **Runtime-proven both directions** on the booted node leg (`test/behavioral`, `projection` case): with the floor, an absent projection row answers `404` + the 7807 envelope; with the ladder reverted, the same request answers **`500 / "internal"`** and logs the domain message as `internal_error`. That was M-T6.31's node half.
- **The two narrow ladders can express 409** (`explicit-handlers-builder.ts`, `workflow-builder.ts`): the `problem` union gained the conflict statuses and the files gained the `DisallowedError` / `ConcurrencyError` / `23505` arms, presence-gated so a project with neither a versioned/event-sourced aggregate nor a `unique` key stays byte-identical.
- Gate: two new per-FILE claims in `test/conformance/problem-arm-census.test.ts` — (a) every emitted `http/*.ts` that declares an `app.onError` has a `problem` type admitting 409, (b) the ladder-LESS routers exist *and* the root floor carries every domain rung at the sibling statuses. Both mutation-proven (revert either router's union → (a) fails; strip the root ladder → both fail).

**One premise of this mission was WRONG and is corrected here.** Consequence 2 says an extern handler that "invokes a `when`-gated operation answers `500 / "internal"`". It does not: on node the `when` state gate is emitted **only at the aggregate ROUTE** (`routes-builder.ts` `whenGateLine`), so an operation invoked from a workflow step or an extern handler **never evaluates the gate at all** — it succeeds. Verified on node and .NET (whose gate lives in `MarkTrackedHandler`, while the workflow handler calls the entity method `ship.MarkTracked()` directly). That is a **state-gate BYPASS on the workflow/extern paths**, a strictly worse defect than the envelope one, and it is unfixed — it needs a decision about whether `when` is a route-level or domain-level gate on all five backends. **Wants its own mission** (candidate T3/T6, "the `when` gate is not enforced off the aggregate route"). The `DisallowedError` arms #2520 added are therefore reachable today only from user-authored handler code, and say so in a comment at both sites.

Originally: node installed no app-global handler — `api/http/index.ts` mounted five sub-apps with no `onError`, each router carrying its own copy of the ladder. Both halves are closed by #2520 (the root domain floor + the two routers' 409 arms). The original three consequences, kept for the record:

1. **Two sub-apps have no ladder at all** — `projections.ts` (built on a bare `new OpenAPIHono()`, not `newApp()`) and `realtime.ts`. A fault there escapes to hono's default handler: **`500`, `content-type: text/plain`, body `Internal Server Error`** — not 7807, wrong content type. A missing projection row therefore answers **500 where the other four answer 404**.
2. **The two ladders that exist are not the same ladder.** `order.routes.ts` carries eight rungs; `a-routes.ts` (the api-route/extern-handler router — a **write** path, `POST /place`) and `workflows.ts` carry five, and their `problem` signature is literally typed `400 | 403 | 404 | 422 | 500`, so **no 409 is expressible**. They don't even import `DisallowedError` / `ConcurrencyError`. An extern `commandHandler` that saves a versioned aggregate, trips a `unique (…)` index, or invokes a `when`-gated operation answers **`500 / "internal"`** on `/api/place` and **`409`** on `/api/orders/…` — same wire concept, same app, two answers. Reachable exactly as `docs/extern.md` describes the surface.
3. It is the same root cause as M-T6.25 on elixir — per-router error handling with no app-level floor — so the two should probably be fixed with the same shape of change on both backends.

**The work.** Give the root app in `index.ts` an `onError` carrying the full ladder, so every sub-app inherits a floor whether or not it declares one; then the per-router handlers become refinements rather than the only line of defence. Check whether the narrow `problem` signatures on `a-routes.ts` / `workflows.ts` are load-bearing (they look like a hand-maintained union that drifted from the eight-rung one). *(Done as written — the narrow unions were not load-bearing; they were a hand-maintained set that never grew a conflict rung.)*

**Verification.** A per-FILE assertion — the `denial-ladder-override-parity` / `problem-arm-census` shape — that every emitted `http/*.ts` router either declares the full ladder or is provably covered by the root one. Joined-output `toContain` cannot see this: a sibling router always satisfies it, which is the trap already documented in both those suites.

Sources: M-T9.25 census sweep 3 (409/500). Twin of M-T6.25; relates to M-T6.26 (the same "read paths answer a different shape from write paths" defect on dotnet/java).

## M-T6.32 — ~~Capability emission: the four capabilities that gate honestly and emit nothing~~ — `closed on the platform axis` (2026-08-17, re-verify changed the answer) · **M** · P1 ⭐ silent-governance class
The mission's own **first step was "re-verify"**, and the re-verify overturned it: all four capabilities emit on **all five backends**. Each set literal below is in `src/ir/validate/checks/system-checks.ts`; the gate each one feeds can no longer fire for a shipping backend, so it now guards a future un-ported one.

| Capability | Gate | Set literal | Emitters |
|---|---|---|---|
| `filter` capability | `loom.context-filter-unsupported` | `supportsNonRelationalFilter` / `supportsPrincipalNonRelationalFilter` | 5/5 on `relational` + `embedded`; 4/5 on `document` (node in-app over the rehydrated doc, java `findAll().stream()`, python `documentCapabilityBody`, .NET `_CapabilityVisible` in `renderDocumentRepositoryImpl` — landed #2530) |
| `ignoring` bypass | `loom.filter-bypass-unsupported` | `FILTER_BYPASS_FAMILIES` = `dotnet, node, elixir, java, python` | EF `IgnoreQueryFilters`, Drizzle conjunct omission, Ecto `where:` omission, Hibernate named `@Filter` + `session.disableFilter`, SQLAlchemy static conjunct omission |
| `audited` operations | `loom.audited-backend-unsupported` | `AUDIT_OP_BACKENDS` = all five | `audit_records` side table on each — pinned per backend by `test/platform/backend-parity-gates.test.ts` (`marker` per backend) |
| `provenanced` fields | `loom.provenanced-backend-unsupported` | `PROVENANCE_BACKENDS` = all five | `provenance_records` on each — same test, `marker` per backend |

**Two residues survive, and neither is on this mission's axis:**

1. **elixir + `shape: document` capability filters** — the one unwired `(family, shape)` cell in `validateContextFilterSupport`. Everything else in that function is covered, which is why the diagnostic's own wording ("only wired for relational aggregates") was corrected in the same pass that closed this row.
2. **`ignoring` under `persistence: dapper`** — an ADAPTER cell, not a platform one. `FILTER_BYPASS_FAMILIES` is keyed by family, so `dotnet` passes the gate whatever its adapter; but `src/generator/dotnet/emit/dapper.ts` applies `agg.contextFilters` and contains **zero** occurrences of bypass handling, so an `ignoring` clause is silently not honoured there. Tracked on the adapter axis by **M-T6.35**; the dapper adapter is also under active work in the in-flight M-T6.42 PR.

The general lesson is the one M-T6.33 already recorded one row over: a register row classified `gap` and never re-verified decays into a claim about the past. Both of this track's "re-verify first" missions were overturned by the re-verify.
Sources: M-T9.27 register rows (the stale premise); overturned against the four set literals cited above and `backend-parity-gates.test.ts`. Relates to M-T3.2 (`mask unless`, the same silent-governance class, still missioned) and M-T6.35 (the adapter axis, where residue 2 lives).

## M-T6.33 — Lifecycle stamps: one rule wearing five names — `done` (2026-08-11) · **S–M** · P2 ⭐ the re-verify changed the answer
**Verdict: they were never gaps.** The mission's first job was to re-verify the classification, and it overturned it. `loom.{node,dotnet,java,python,elixir}-stamp-unsupported` were five codes over one shared body, and reading that body settled both questions at once:

1. **Neither arm is backend-specific.** The check reads only `dep.auth`, `sys.user` and `agg.persistedAs` — facts about the MODEL. It never consults a backend capability. The per-backend stamp *mechanisms* genuinely differ (Java `_stampOnCreate`, .NET EF `AuditableInterceptor`, node Hono write hooks, python pre-persist, Elixir Ecto `put_change`) — but none of them is what these arms are about; the family only ever selected a message noun.
2. **Neither arm is a gap.** A principal stamp on a deployable with no auth has *no principal to read* — no backend can implement that, and the message already says how to fix it: a plain misuse rule. A stamp on an event-sourced aggregate contradicts the storage model — stamps mutate state fields, and event-sourced state is folded from its event stream: impossible everywhere, forever.

**Landed:** five codes → **two named for what they mean** — `loom.stamp-principal-without-auth` (misuse) and `loom.stamp-on-event-sourced-invalid` (impossible). Split by meaning rather than merged to one `loom.stamp-unsupported`, because the two arms are different failures with different fixes and a caller matching on identity should tell them apart. Five `validateXStampSupport` functions → one `validateStampSupport` walking deployables once. Target names leave the identity per [M-T5.21](./missions/M-T5.21-callable-unification-design.md) §Symptom 1 (a backend-named code becomes a lie the day that backend supports it).

**Register effect:** all five rows leave — they were never work. `MAX_OPEN_GAPS` **42 → 37**, the first drop since the register was minted, and it came from re-classification rather than from emitting anything.

**Coverage gap found and closed:** the event-sourced arm was tested in only three of the five generator suites (dotnet and java asserted the principal arm only). With one shared body the arm belongs at the IR layer, so `test/ir/stamp-support.test.ts` now covers it per-family; mutation-proven (disabling the arm fails exactly those five cases and nothing else).
Sources: M-T9.27 register rows; `system-checks.ts` `validateStampSupport`.

## M-T6.34 — ~~Event-sourced storage exists on one backend of five~~ — `closed` (2026-08-17, premise overturned) · **L** · P2
**The premise is false on current `main`: both halves are 5/5.** The mission was minted off M-T9.27 register rows and never re-verified; the ports landed in the interim and the row did not move.

- **Aggregate half.** `EVENT_SOURCING_BACKENDS` (`src/ir/validate/checks/system-checks.ts`) is `new Set(["node", "dotnet", "python", "java", "elixir"])`. `validateEventSourcedStorage` diffs the hosting backends against that set, so `loom.event-sourcing-backend-unsupported` cannot fire for any shipping backend — it fires only when NO backend hosts the context, or for a future un-ported one. The elixir entry is not a rubber stamp: plain Ecto/Phoenix hosts pure ES through the per-aggregate stream + fold-on-load data layer (D-VANILLA-ES-HOME).
- **Workflow half** — the part the mission called "unbuilt everywhere". `EVENT_SOURCING_WORKFLOW_BACKENDS` (same file) is the same five-element set, and its own comment states the emitters: "the **node, .NET, Python, Java, and elixir backends all emit the event-sourced workflow runtime** (per-correlation `<wf>_events` stream, fold-on-load, emit→append-own-event dispatch)". `validateEventSourcedWorkflowStorage` returns early when `unsupported.length === 0`, which is always.
- **Pinned, not just asserted.** `test/platform/backend-parity-gates.test.ts` drives the `loom.event-sourcing-backend-unsupported` row with a per-backend `emits` set of all five plus a per-backend output `marker`, so the claim is gated on emitted artefacts rather than on the set literal alone.

No residue on this mission's axis. The ADAPTER axis is a different question and is tracked by M-T6.35.
Sources: M-T9.27 register rows (the stale premise); overturned against the `EVENT_SOURCING_BACKENDS` / `EVENT_SOURCING_WORKFLOW_BACKENDS` literals in `system-checks.ts` and their `backend-parity-gates.test.ts` row.  (Cited by SYMBOL, not line: this file's own citations went stale the moment the cited file was edited.)

## M-T6.43 — Java's JPA entities emit unquoted column names, so a reserved-word field 500s on insert — `done` (2026-08-18) · **S–M** · P1 ⭐ compiles green, boots green, fails on first write

Found 2026-08-17 while landing M-T6.42, by running the new `reserved-words`
corpus fixture's behavioural leg against a real booted Spring Boot + Postgres.
The SAME class M-T6.42 fixed on the Dapper adapter, on a second backend.

The JPA entity names the column bare:

```java
@Column(name = "order")
int order;
```

Hibernate then writes `insert into orders.tickets (order, group, limit, …)` and
Postgres refuses it. The request answers **500 `internal`**:

```
POST /api/tickets → 500 {"detail":"internal","title":"Internal Server Error", …}
```

**Why every existing gate is green.** The Java project COMPILES (`gradle
testClasses bootJar` succeeds — the column name is an annotation string). The
schema is fine, because Java's DDL comes from the SHARED `sql-pg.ts` migration
renderer, which has quoted always since G2 — so `schema-load` passes and the app
BOOTS. Only a write reaches the defect, which is why it needed a behavioural
witness rather than a compile or schema one.

**The fix** is Hibernate's portable quoting — a backtick-wrapped name, which
Hibernate converts to the dialect's quote character — applied at the ~16
dynamic `@Column(name = …)` sites (nearly all in
`src/generator/java/emit/jpa-annotations.ts`), plus any `@SQLRestriction`
predicate that names a column. The reserved-word set already exists as
`PG_RESERVED_IDENTS` in `src/generator/dotnet/emit/dapper.ts`; landing this
should LIFT it to a shared home (`src/generator/` or `src/util/`) rather than
copy it — two lists of Postgres keywords is exactly the drift M-T6.42's own
header warns about.

**Verification when it lands.** `test/fixtures/corpus/reserved-words.ddd`
already exists and already covers every clause position; the ratchet is widening
its `backends:` row from `QUOTES_RESERVED_IDENTIFIERS` back to `ALL` in the same
PR. `node run-java.mjs reserved-words` is the proof, and it fails today — it
needs JDK 25 + Gradle 9.1+, which the sandbox host does not ship by default
(see `docs/tools.md`).

**Not affected, checked rather than assumed:** node/drizzle, python and .NET EF
all round-trip the fixture against the golden; elixir is safe by construction
(Ecto takes column names as ATOMS — `field :order` / `add :order` — and quotes
every identifier it renders, so no raw name reaches the SQL).

**Sources:** M-T6.42 (the sibling fix and the fixture), `sql-pg.ts`'s
quote-always rule, the behavioural java leg.

**Outcome.** Landed as described, with the shared-home step taken first: the
word list moved out of the Dapper emitter into `src/generator/sql-reserved.ts`
(one `isReservedIdent` predicate, no escaping — that stays per-backend), and
re-deriving it from a live `postgres:16` for the second consumer immediately
found the drift the mission predicted: **`right` was missing** from the
Dapper-resident list, and `create table t (right int)` really is a syntax error.
One word, found the first time the list was checked against the server rather
than copied — which is the whole argument for the file.

Java quotes with Hibernate's portable backtick at the `@Column` / `@Table` /
`@AttributeOverride(column = …)` sites (`emit/jpa-annotations.ts`, plus the
audit / claim / containment columns in `emit/entity.ts` and the correlation
columns in `emit/workflow-state.ts` + `emit/projection-state.ts`), and with
POSTGRES `"…"` in `render-sql-restriction.ts`, whose fragment Hibernate appends
as raw SQL. That renderer needed one structural change beyond the wrapper: the
flattened-VO arm built its column by concatenating rendered segments, so
quoting in place would have produced `"order"_deleted_at`. The path is now
built unquoted by `columnPath` and quoted once, at the end.

Compound names the emitter derives (`<owner>_id`, `<field>_provenance`,
pluralised tables) are deliberately NOT run through the predicate — they can
never collide, and quoting them would move output for nothing.

**Proof.** `node run-java.mjs reserved-words` passes and its recording matches
the committed wire golden (node is the oracle). Mutation-proved: with `hbIdent`
reverted to the identity function the same leg fails by name — *reserved-word
columns round-trip through create, find and read against d* — with
`POST /api/tickets → 500`, i.e. exactly the reported defect. Byte-identity
checked by generating all 50 corpus fixtures before and after on BOTH affected
backends: the Java tree differs in exactly one file (`reserved-words`'
`Ticket.java`, three columns) and the Dapper tree is unchanged everywhere,
confirming `right` has no witness in the corpus. `test/generator/java/java-reserved-identifiers.test.ts`
is the fast per-PR pin, and one PRE-EXISTING assertion in
`generator-java-projection.test.ts` had been pinning the broken spelling
(`@Column(name = "order")` on a projection correlated by a field named `order`)
— it now pins the quoted one.

## M-T6.42 — `persistence: dapper` emits unquoted identifiers, so a reserved-word column breaks the DDL — `done` (2026-08-17) · **M** · P1 ⭐ boots red, compiles green
*(ID note: this row was minted as M-T6.41, colliding with the direct-table-aggregation row of the same number further up this file. Renumbered to **M-T6.42** on `main` while the fix was in flight — that is the id this PR already used, so the two agree. Fourth dup-ID incident; M-T9.32's automation remains the fix.)*

A `.ddd` field named `order` / `user` / `group` / `end` — any of Postgres'
~100 reserved words — makes the Dapper adapter's emitted schema a **syntax
error**:

```
CREATE TABLE IF NOT EXISTS order_books (
    order uuid primary key,     -- ERROR: syntax error at or near "order"
    code text
);
```

Reproduced 2026-08-16 by `psql -f`-ing `test/fixtures/corpus/read-gates.ddd`'s
emitted `DbSchema.cs` (its folded projection is `keyed by order`).

**Every gate is blind to it.** The C# compiles — the SQL is a string literal, so
`dotnet build /warnaserror` passes. `schema-load.yml` loads the MIGRATION chain,
which the Dapper adapter does not use (`hasMigrations = !usingDapper`; it
provisions itself through `DbSchema.EnsureAsync`). It surfaces only at BOOT.

**The rest of the toolchain already decided this question.** `sql-pg.ts` quotes
identifiers ALWAYS, and says why in its own comment: "safe for reserved words
(`order`, `user`, `end`)". The Dapper adapter never picked the rule up.

**Why it is its own mission and not a one-liner.** The identifier appears in ~43
`new CommandDefinition("…")` sites across `emit/dapper.ts`,
`emit/dapper-workflow.ts` and `projection-emit.ts`, and those SQL strings live
in TWO different C# escaping contexts — regular literals (need `\"`) and the
verbatim `@"…"` in `DbSchema.cs` (needs `""`). Quoting the identifier without
fixing the escaping at each site produces C# that does not compile. A partial
fix is worse than none: quoting only the DDL makes the schema load and then the
queries fail.

**Verification when it lands.** A corpus fixture with a reserved-word column
(`read-gates` is already one, via `keyed by order`), plus extending the
`schema-load` gate to `psql -f` the Dapper `DbSchema.Sql` — the oracle that
would have caught this from the start, and the reason the class stayed invisible.

**Sources:** found while landing M-T6.25 (the port that first let `read-gates`
generate under this adapter). Sibling of M-T6.35 — a persistence-ADAPTER gap,
the axis the "five backends" framing hides.

### Outcome (2026-08-17)

`sqlIdent` (`emit/dapper.ts`) quotes the ~100 Postgres reserved words at every
identifier position this adapter emits — CREATE TABLE / CREATE INDEX, the
SELECT and INSERT column lists, the `ON CONFLICT … DO UPDATE SET` assignments,
`whereToSql`'s column arm, a retrieval's ORDER BY, the join-table and
child-table DDL, and the paged sort allowlist. Non-reserved emission is
**byte-identical** — proved by regenerating every corpus fixture under
`persistence: dapper` before and after and diffing to zero.

**The escaping was the whole difficulty**, and the reason #2559 reverted an
attempt rather than shipping one. The identifier reaches C# through two string
contexts: ~47 `new CommandDefinition("…")` REGULAR literals (`\"order\"`) and
exactly ONE verbatim `@"…"` in `DbSchema.cs` (`""order""`). `sqlIdent` emits
the regular-literal form and the single verbatim funnel re-encodes on the way
in (`ddlToVerbatimLiteral`), so no call site has to know which context it is in
— and the one that does is small enough to read in full.

**Two gates, because the two halves fail in different places.**

- `schema-load` grew a dapper leg: it `psql -f`s the emitted `DbSchema.Sql`
  into a real Postgres, statement by statement, the way `EnsureAsync` runs it.
  That is the oracle whose absence hid this — the existing leg loads the
  MIGRATION chain, which this adapter does not use.
- `dapper-reserved-identifiers.test.ts` pins the DML half clause by clause,
  because a C# string compiles whatever it contains and no per-PR tier boots
  this adapter against a database. Mutation-proven that schema-load CANNOT see
  a DML-only break — quoting the schema alone would have left every query
  broken with every gate green, which is worse than the original defect.

`test/fixtures/corpus/reserved-words.ddd` is the permanent witness, declared on
all five backends, so the class stays exercised rather than depending on some
other fixture happening to name a reserved word (the way `read-gates` did
until it was renamed to `keyed by order_ref` and the witness silently
disappeared).

**Not covered, stated rather than implied:** a field named after a HOST-LANGUAGE
keyword (`is`, `default`, `class`) still breaks the generated row DTO / entity
on every backend. Different class, different fix, no backend claims it today.

## M-T6.35 — Persistence-adapter capability gaps — `open` · **M** · P2
The non-default persistence adapters reject shapes their EF/Ecto siblings accept: `loom.dapper-unsupported` (features Dapper does not emit), `loom.find-predicate-unsupported` (a find predicate the active adapter cannot lower), `loom.persistence-mode-unsupported` (a `persistedAs`/`shape` pair the adapter cannot store), `loom.saving-shape-unsupported` (a `shape(...)` the hosting backend cannot persist), `loom.vanilla-document-unsupported` (`shape: document` only partly emitted on Elixir). The adapter axis is where "all targets support the whole surface" costs the most, because each adapter multiplies the matrix again — worth confirming per row whether the adapter *cannot* express the shape (a permanent limit, so a rename) or merely *does not yet* (a gap).
Sources: M-T9.27 register rows. Relates to M-T6.23 (mikroorm) and M-T6.25 (dapper query-time projections) — the same axis, already missioned.

## M-T6.36 — Java emitter shape gaps — `open` · **S** · P3
Two narrow Java-only rejections: `loom.java-projection-field-unsupported` (projection field shapes the emitter does not handle) and `loom.java-workflow-instance-field-unsupported` (workflow instance field shapes). Both name Java in the code identity, which M-T5.21 §Symptom 1 argues against — fold the target into the message when the shapes land.
Sources: M-T9.27 register rows.

## M-T6.37 — Elixir emits no seeder: `seed` datasets are silently dropped — `open` · **M** · P1 ⭐ silent gap in a feature claimed on five backends
`seed default { … }` / `seed <name> [raw] { … }` emits a first-boot seeder on four backends and **nothing at all** on `platform: elixir`: `priv/repo/seeds.exs` is listed in the Phoenix file map (`docs/generators.md`) and reserved as a layout slot (`elixir/adapters/by-feature-layout.ts` → `"seeds"`), but no emitter writes it and nothing reads `ctx.seeds`. So reference data an author declared simply does not exist there, with no diagnostic — while `manifest.ts` claims the `seeding` feature on all five backends and the corpus compile tier is green (there is nothing to fail to compile).

Invisible until #2517 (M-T9.13) gave the fixture's collection reads their first callers: seed rows are only observable through a list read, and the node behavioural leg did not run its own seeder either. Registered honestly meanwhile as `BEHAVIOURAL_SKIP.elixir["seed-values"]` (the fixture that carries only the seeded-collection reads — `seeding`'s CRUD/FK/404 half stays armed on this backend) + [B19](../audits/behavioral-parity-bugs-2026-07.md#b19--elixir--seed-datasets-emit-no-seeder-at-all-silently-dropped); **deleting that entry is the acceptance test.**

Scope: an Ecto seeder module — domain rows through the context `create` path (so invariants run, per D-SEED-PATH), raw rows as **schema-qualified** INSERTs (the qualifier bug #2517 fixed on node/.NET; python/java were always right), the ship-once `__loom_seed` marker (D-SEED-IDEMPOTENCY) and `LOOM_SEED` dataset gating — plus its invocation at boot beside the migrations. The java `<Ctx>SeedRunner` (`generator/java/emit/seed.ts`) is the closest model. Verify with `node run-elixir.mjs seeding` in the Elixir docker image, not with a string assertion.

## M-T6.38 — A `when` state gate is not enforced off the aggregate route — `open` · **M** · P1 ⭐ silent gate bypass, not a wire divergence
Found 2026-08-11 while landing M-T6.28 ([#2520](https://github.com/lemmit/Loc/pull/2520)), by **disproving that mission's own premise.** M-T6.28 claimed an extern `commandHandler` that "invokes a `when`-gated operation answers `500 / "internal"`". It does not. **It succeeds.**

The `when` predicate (criterion.md use site 2 — the canCommand state gate) is emitted at the **route/handler layer only**:

| backend | where the gate lives | what a workflow step / extern handler calls |
|---|---|---|
| node | `routes-builder.ts` `whenGateLine` — inside the aggregate route handler | the DOMAIN method (`ship.markTracked()`), which carries no gate |
| dotnet | `Application/<Agg>/Commands/<Op>Handler.cs` | the ENTITY method (`ship.MarkTracked()`) — verified in the emitted `…OnShipmentRequestedHandler.cs` |
| java, python, elixir | `<Agg>Service.java` / `<agg>_routes.py` / the context module `<ctx>.ex` | **unverified — re-verify before building** |

So on node and .NET a state-gated operation invoked from a workflow step, a saga cascade, or an extern handler **runs with the gate unevaluated**: no `DisallowedError`, no 409, the write lands. Verified empirically on both (generate a `when`-gated `markTracked()`, invoke it from an `on(e)` workflow step, read the emitted files: the gate appears in the route/handler and nowhere the workflow reaches).

**Why this is worse than the envelope defects around it.** M-T6.25/6.28/6.31 are contract bugs — the right refusal in the wrong shape. This is the *absence of the refusal*: a rule the model declares, the validator accepts, and the docs describe as enforced, which silently does not run on the paths that reach the aggregate from inside the system. It is the silent-governance class (cf. M-T6.32, M-T3.2), applied to state rather than authorization — and `requires` gates deserve the same question asked of them on these paths.

**Why no gate saw it.** Every `when` test drives the ROUTE (which is correct). No fixture invokes a gated operation from a workflow step or extern handler, so nothing has ever asked the question; and the wire goldens cannot see it, because the request that should have been refused *succeeds* — there is no error body to diff.

**The design decision is NOT made, and this mission must not make it.** Two coherent answers, and they differ in blast radius:
1. **Domain-layer gate** — the `when` predicate moves into (or is also asserted by) the aggregate's own method, so every caller is gated. Correct-by-construction, but it changes the emitted domain classes on five backends and makes the gate a domain invariant, which needs an owner call on whether `when` is part of the model's meaning or part of its HTTP surface.
2. **Route-layer by design** — `when` stays an API-edge gate, and the language says so explicitly (docs + a validator note), leaving in-system callers deliberately ungated because the workflow *is* the authority. Cheap, but it must be written down, and `docs/criterion.md` currently reads as if the gate is unconditional.

**First step: no code.** (a) finish the per-backend verification table above; (b) get the owner decision on 1 vs 2 (D-tag it in `docs/decisions.md`); (c) only then size the work. Sized M as a placeholder for (a)+(b) plus one backend of whichever answer wins — expect a re-size.

**Verification when built.** A behavioral case, not a static pin: the golden cannot express "the request that should have been refused succeeded", so the fixture must drive a gated operation through a workflow step and assert the state did NOT change (the shape M-T6.27's two-writer case wants). A static per-backend pin that the gate appears on the path the workflow calls is the cheap companion.

Sources: found by [#2520](https://github.com/lemmit/Loc/pull/2520) (M-T6.31 + M-T6.28); the corrected premise is recorded in M-T6.28's body. Relates to M-T6.32 (silent-governance class) and M-T3.2 (the same class on authorization).

> **ID note.** Minted as M-T6.37, renumbered to M-T6.38 before merge: [#2517](https://github.com/lemmit/Loc/pull/2517) (the M-T9.13 drain) had claimed M-T6.37 for the Elixir-seeder gap in the same hour, and neither PR could see the other's ID on `main`. First claim wins. The next-free-ID check has to span open PR branches, not just `main` — which is [M-T9.32](./T9-toolchain-health.md)'s job (dup-claim automation, minted by #2495); this is a live instance of what it exists to prevent.

## M-T6.39 — The `/files/{key}` absent-object 404 is a fourth envelope, on zero backends — `open` · **S–M** · P2
Found 2026-08-11 by the M-T6.31 drain, at the one absent-read site outside that mission's five.

`GET /files/{key}` (the root file-download route over the bound `objectStore` — M-T1.2) answers a missing object in **two shapes, neither of them RFC 7807**:

| backends | body | content-type |
|---|---|---|
| node, python, elixir | `{"error":"not found"}` | `application/json` |
| dotnet, java | *empty* | none |

Emission sites: `src/generator/typescript/emit/routes.ts` (the `app.get("/files/:key", …)` block), `src/generator/python/files-routes-builder.ts`, `src/generator/elixir/vanilla/files-controller-emit.ts`, and `emit/program.ts` on both dotnet (`Results.NotFound()`) and java (`ResponseEntity.notFound().build()`).

**This is not the same fix as M-T6.31.** There, the correct envelope already existed in each app and the read sites merely had to reach it; here **no backend emits one on this route at all**, so it is a genuine wire change on the three that currently send `{"error":"not found"}` — a client parsing that key is broken by the fix. That is why it was deliberately left out of #2520 rather than folded in: it wants its own claim and its own reviewed golden diff.

Two sub-decisions to settle in the PR, neither hard: (a) the `detail` sentence — `"file <key> not found"` is the RS-27-shaped answer, but the resource is an object key, not an aggregate id; (b) whether the route joins each backend's shared 404 producer (the M-T6.31 answer, and the reason those arms can't drift again) or hand-builds the body — on dotnet/java it is a **minimal-API / plain-controller** route, so `DomainExceptionFilter` / `ApiExceptionAdvice` do **not** apply to it as-is, which is the actual work.

**Verification.** The absent-read wire-golden probe #2520 added (`test/behavioral/wire-differential.mjs`) is the natural home — extend it to `/files/<absent-key>` for any case that uploads a file, and the envelope is gated on all seven legs. A static five-backend site pin (the `absent-read-envelope-parity.test.ts` shape) is the fast companion. Note the corpus gap first: `resources.ddd` exercises the object store but no committed golden reaches the download route.

Sources: found by [#2520](https://github.com/lemmit/Loc/pull/2520) while draining M-T6.31; recorded in that mission's body as the remaining site. Relates to RS-22 (the envelope's membership) and M-T6.31 (the same class, the aggregate/projection/instance sites).

---

## M-T6.40 — A non-paged author `find all` + a scaffolded Elixir list page emits a project that will not compile — `open` · **S** · P2

**The bug.** An author-declared `find all(): T[]` (non-paged) on a `platform: elixir` deployable that also mounts a scaffolded `ui` emits a LiveView calling `list_<agg>s/4` against a context that defines `list_<agg>s/0`:

```elixir
# lib/<app>_web/live/order_list_live.ex
case PhoenixApp.Sales.list_orders(socket.assigns.page_num, 10, socket.assigns.sort_key, socket.assigns.sort_dir) do

# lib/<app>/sales.ex
defdelegate list_orders(), to: PhoenixApp.Sales.OrderRepository, as: :list
```

`mix compile --warnings-as-errors` fails with `PhoenixApp.Sales.list_orders/4 is undefined or private`, naming all three call sites (`handle_params/3` and both `handle_event/3` clauses). Nothing rejects the combination up front, so this is a SILENT gap: the `.ddd` validates, generation exits 0, and only the compile tier — which no fixture reaches — says otherwise.

**Repro** (verified 2026-08-13, docker `hexpm/elixir` + `LOOM_HEX_MIRROR=1`): take `test/e2e/fixtures/elixir-vanilla-build/vanilla-list-read-gate.ddd` and change its `find all(): Order paged` to `find all(): Order[]`. Independent of the read gate — it reproduces with the `requires` clause removed entirely.

**Why it survived.** The scaffolded list page assumes the enrichment-injected paged `findAll` (M-T2.6), which is what every other Elixir fixture has; an author-declared `all` replaces it (`ensureFindAll` — theirs wins) and may be non-paged. No fixture in `test/e2e/fixtures/elixir-vanilla-build/` paired an author-declared `find all` with a `ui` until `vanilla-list-read-gate.ddd`, so `mix compile` never saw the shape.

**The decision this needs** (why it is not a drive-by fix): which side is wrong. Either (a) the scaffolded page should call the arity the repository actually exposes — dropping the page/sort assigns for a non-paged `all`, which silently un-pages the UI; or (b) the validator should reject a non-paged author `find all` on a deployable whose scaffolded ui renders a paged list, which is honest but rejects a `.ddd` that is fine on the other four backends. (b) reads correct — the scaffold's list page IS paged and cannot be un-paged without changing what it renders — but it is a new `loom.*` gate over a shape that compiles elsewhere, so it wants the parity call made deliberately.

**Verification.** The fixture is already in place: flip `paged` off in `vanilla-list-read-gate.ddd` and the elixir-vanilla-build cell fails. Whichever side is chosen, add a fixture (or a validator negative test) pinning the non-paged pairing, so the compile tier keeps reaching it.

Sources: found by [#2544](https://github.com/lemmit/Loc/pull/2544) while adding compile coverage for the LiveView list-read gate — the fixture it needed tripped this first.
