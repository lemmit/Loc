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

## M-T6.6 — Python document filters — `open` · **M** · P3
The last capability-filter cell: `filter` on a python `shape: document` aggregate (in-app blob filtering like node/java do). Principal-on-document stays a design decision — either implement or pin the gate as permanent with a D-tag.
Sources: parity register row 1, DEBT-02 residue.

## M-T6.7 — Node criterion filter leak — `done` (verified 2026-07-13) · —

## M-T6.8 — SYS-1: update-path wire validation — `done` (PR #1883, 2026-07-13) · —
Sources: [generated-code-review-2026-06-30](../audits/generated-code-review-2026-06-30.md) SYS-1.

## M-T6.9 — Adapter subsets: Dapper/MikroORM → FULL PARITY (drain) — `done` (9 waves, 2026-07-18/19) · **XL** · P3
Sources: DEBT-17/18, parity register adapter sub-matrix.

## M-T6.10 — Vanilla as a first-class adapter + `resolvePersistence()` — `done` · **M** · P3
Sources: global-plan T2.d, [platform-realization-axes](../old/proposals/platform-realization-axes.md) residue, M-T9.2 design doc.

## M-T6.11 — Reserved `PlatformSurface` hooks (DEBT-27) — `blocked(T3/T4 features)` · — · P3
`emitAuthGate`/`emitAuditInit`/`emitCompliancePolicy`/`emitTenancyFilter`/`emitI18nAdapter` are no-op hooks with zero implementations. Don't build speculatively — each fills when its owning feature (M-T3.x / M-T1.11) reaches emission. Tracked here so the hooks aren't forgotten or cargo-culted.

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

## M-T6.23 — `persistence: mikroorm` non-persistence feature gaps — `partial` (gates landed; emitters open) · **M–L** · P2 ⭐ was silent
M-T6.9 drained the MikroORM adapter to full parity with drizzle on the **persistence** axis, and the validator's comment block said so without qualification. But **five non-persistence features are gated `&& !usingMikro` in the Hono emitter** and emitted *nothing*, with no diagnostic — a valid model generated a project with the feature simply absent and the CLI reported success:

| feature | file drizzle writes | mikroorm | now |
|---|---|---|---|
| query-time `projection` (`from … select …`) | `http/query-projections.ts` | — | error |
| `timerSource` | `scheduler.ts` | — | error |
| broker `channelSource` | `http/channels.ts` | — (compose still starts the broker) | error |
| durable channel + local reactor | outbox + relay wiring | — (silently at-most-once) | error |
| realtime (`delivery: broadcast`) | `http/realtime.ts` | — | error / warning (below) |

**Landed (gates, 2026-07-30):** all five are `loom.mikroorm-unsupported` diagnostics naming the omitted file and the way out (`src/ir/validate/checks/system-checks.ts`, `validateMikroOrmSupport`); `test/ir/mikroorm-feature-gates.test.ts` pins both directions per feature (mikroorm rejects, the same model on drizzle stays clean). Only R1 (the projection case) was on record — in [`integrity-audit-2026-07-residue.md`](../old/proposals/integrity-audit-2026-07-residue.md), which proposed exactly this interim; the other four were unrecorded.

**The realtime severity split** is the load-bearing design call: a `broadcast` channel does double duty, and its *routing* half (what makes a projection fold or saga subscribe) works fine on this adapter. A frontend targeting the backend emits `src/api/realtime.ts` off the target's **platform**, not its persistence, so its EventSource would poll a 404 → **error**. With no such frontend the wire is unobserved and the fold/saga path is intact → **warning**. Without that split the gate rejects working models (it broke 4 `test/adapters/` suites and 3 corpus features before the split).

**Open (the principled fix):** port the five emitters to the EntityManager — a projection read-model query path, a `scheduler.ts` on the mikro connection, the broker driver/tee/consumer, an outbox table + relay, and the SSE wire. Each closes by **deleting its clause** here; the gate is the interim, not the answer. Sequence by blast radius: outbox (unblocks the `outbox` corpus feature) → broker → timers → query-time projection → realtime.

**Hollow-cell note (feeds M-T9.8):** `channels-broker` and `outbox` were **passing** on the mikroorm behavioural leg (`test/behavioral/run-mikroorm.mjs`) with the feature absent — the api-tier assertions are satisfied by the synchronous in-process dispatch that survives on this adapter, so the missing broker driver and outbox relay were invisible to a green run. Both are now honest entries in that runner's `MIKRO_SKIP` register. A `done` mission's gate can still be hollow; this is what that looks like.

Sources: found 2026-07-30 auditing the archived proposal corpus for unmapped work (R1 was the thread that led to the other four). Gate reproduced as a silent drop first (generate on mikroorm vs drizzle, file trees diffed), then as a diagnostic.

## M-T6.22 — Drain the M-T9.11 differential findings (RS-11/RS-12) — `done` (2026-07-28) · **M** · P2

## M-T6.24 — Elixir: the two remaining untyped denial edges — `open` · **S** · P3 ⭐ one is an info leak
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
*(Renumbered from the placeholder "M-T6.x" and re-statused 2026-08-05 — `landed` isn't a legend status. Create-path parity is done (below, #2377); the update-path halves landed via #2392 ("a default never relaxes an update" — Elixir enforced less than promised, Java rejected what it advertised); the remaining residue is in-flight as draft PR #2440 — Elixir accepts a PUT that omits a required field (presence is a deserialization question there too), with retro §79 (open PR #2415) as its documentation twin.)*

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
`isRequiredUpdateInput` for the PATCH seam, where an explicit default stays
required and only the bool relaxation applies — matching the other four).

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

## M-T6.25 — `persistence: dapper`: query-time projections are EF-coupled — `open` · **M** · P2 ⭐ two shapes silent

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
