# Global Implementation Plan — `docs/proposals/`

> **Status:** REFERENCE — the authoritative "what's next" for the whole
> proposal corpus. **Rewritten 2026-06-10 from a code-verified audit**:
> every claim below was checked directly against the grammar
> (`src/language/ddd.langium`), the IR (`src/ir/types/loom-ir.ts`), the
> validator gates (`src/ir/validate/checks/*`), and the per-backend
> emitters — not against prior doc text, which had drifted badly.
>
> This document **supersedes** two earlier ones:
>
> - the previous `global-implementation-plan.md` (drafted before the
>   #700 wave and patched incrementally since — its audit tables,
>   phase structure, and kitchen-sink appendix are retired; recover
>   them from git history if needed);
> - `remaining-work-plan.md`, the separate carry-over digest, which is
>   **deleted** — its role (a one-page "what's left") is §"Suggested
>   near-term order" below.
>
> Division of labour: per-proposal status lives in the
> [`README.md`](./README.md) status table; binding design decisions in
> [`../decisions.md`](../decisions.md); the cross-backend gate matrix in
> [`platform-parity-debt.md`](./platform-parity-debt.md). This plan owns
> the **gap inventory, ordering, and dependencies**. When this plan and
> cited code disagree, the code wins — refresh this doc.

## Maintenance rule

When a batch of work lands, update three places in one PR: the item
here (delete it — the git log is the record of what shipped), the
proposal's own status header, and the README row. A status header that
says "not yet started" while the emitter exists costs the next agent
hours of re-verification — that is the failure mode this rewrite fixes.

---

## Current state on `origin/main` (2026-06-10, condensed)

The ten-phase pipeline, three DB backends (node/Hono, .NET, elixir —
both `ash` and `vanilla` foundations), and the React frontend are
mature. Recent waves the older docs had not absorbed:

- **Elixir platform rename** (#1043) — `platform: elixir` canonical;
  back-compat aliases for `phoenix`/`phoenixLiveView`.
- **Vanilla Elixir foundation, state-based** (#1046–#1062, slices 0–6
  incl. 5a views / 5b workflow instances / 5c workflow execution) —
  plain Ecto/Phoenix project, RFC 7807 parity, CI fixture.
- **Workflow instances as view sources** on all backends
  (#1035/#1037).
- **TPH inheritance on all three DB backends**
  (`TPH_CAPABLE = {node, dotnet, elixir}`,
  `src/ir/validate/checks/system-checks.ts`); TPC everywhere.
- **Payload transport**: P1 kinds + file-scope declarations (#1024),
  P2 synthesised `<Agg>Wire`, P3b `Paged<T>` everywhere, P4 named +
  anonymous `or` unions on node/dotnet/elixir.
- **Reified criteria consumed at use-sites** on all four backends
  (`criterionRef` in the IR; .NET `find-emit.ts`/`spec-emit.ts` emit
  `.Where(new XCriterion(args).ToExpression())`).
- **Retrieval emission on all four backends** (#810/#952/#955).
- **RFC 7807 `errors[]`** on all three backends (#782/#829/#836).
- **Seeding**: `__loom_seed` ship-once marker + `raw` direct-INSERT
  path on all three backends; D-SEED-XREF explicit ids.
- **Event sourcing** on node (Drizzle + MikroORM) and .NET (EF +
  Dapper) (#914/#941).
- **Realization-axes alignment slices 1–3** (#1061–#1064): plan +
  ecto/vanilla adapter direction, foundation↔persistence compatibility
  (R6), `transport:` promoted to an adapter axis.
- **C# nullable** in csproj templates + `dotnet build /warnaserror` CI.

## Dropped — do not build on these

- **The `?` propagation operator** (exception-less A2). Maintainer
  decision 2026-06-10: resigned from completely. Surface + validation
  shipped in #1030 with **zero backend codegen**; the surface has since
  been **removed** (grammar rule, `ExprIR` kind, lowering, gates,
  print arm, tests — T1.2, done). The old M2 milestone (A1+A2+A3) is
  obsolete.
- **`@handle` seed cross-row refs** — D-SEED-XREF pinned explicit ids
  instead. (Stale "not yet handled" emitter comments fixed 2026-06-10.)
- **`mutation-testing.md`** — out of scope per maintainer.

---

## Tier 1 — broken or misleading surface (fix first)

Small, high-leverage items where the toolchain currently emits a
runtime trap, silently degrades, or misleads.

| # | Item | Where | Owning proposal |
|---|---|---|---|
| T1.4 | **Docs/comment honesty debt** — keep proposal status headers, the README table, and this plan in sync per the maintenance rule above (the 2026-06-10 pass fixed the then-known liars: seed emitter headers, the TPH validator comment, `ddd patch` missing from `tools.md`, and seven stale proposal headers). | docs | — |

## Tier 2 — nearly done: finish what's in flight

Per-backend completion of features that already ship somewhere. The
elixir items form one coherent track (a→e order).

| # | Item | Where / gate | Owning proposal |
|---|---|---|---|
| T2.a | **Vanilla workflow body lowering** — only `factory-let` + `op-call` lower (#1062); `precondition` / `requires` / `emit` / `repo-let` / `expr-let` / `for-each` / `repo-run` emit `# TODO` comments (`src/generator/elixir/vanilla/workflow-execution-emit.ts:~147-157`). The TDD slices are already cut in [`../plans/vanilla-foundation-tdd-plan.md`](../plans/vanilla-foundation-tdd-plan.md). | elixir/vanilla | [vanilla-phoenix-foundation](./vanilla-phoenix-foundation.md) |
| T2.b | **Event sourcing under vanilla** (D-VANILLA-ES-HOME) — ✅ **SHIPPED** (#1203 P4.0 per-op endpoints → #1205 P4.1/P4.2 gate + emit). `persistedAs(eventLog)` now generates on `foundation: vanilla` (foundation-aware gate: `elixir+vanilla` accepted, `elixir+ash` still rejected); emits the in-memory struct + `<Agg>EventLog` schema + `<Agg>Fold` + event-store repository + emit→append→fold command runners. Remaining tail tracked under T3.6 (projections/snapshots) and P4.3/P4.4 in [`../plans/elixir-eventsourcing-vanilla-plan.md`](../plans/elixir-eventsourcing-vanilla-plan.md) (conformance-parity case, VO/enum applier folds, dispatch fan-out). | ~~elixir/vanilla~~ | [workflow-and-applier](./workflow-and-applier.md) |
| T2.c | **Operation `or`-union returns on elixir** — ✅ **SHIPPED on `vanilla`** (#1208). `validateOperationReturnsUnimplemented` is foundation-aware (`elixir+vanilla` accepted, `elixir+ash` still gated); the context fn returns a tagged `{:ok, value} \| {:error, tag, data}` tuple and the controller translates each variant to its status (RFC-7807 ProblemDetails / 200), reusing the shared `util/error-defaults` resolution. `precondition`/`emit`/`assign` inside a returning op + success-path serialization ✅ #1221. The **custom-find HTTP surface** (#1217, `GET /<plural>/<find>`) and the **union-find absence producer** (#1218 — single-get + tagged success + absent→ProblemDetails; `validateUnionFindShapes` is now foundation-aware, exempt on Ash only) also shipped on vanilla. The **cross-backend *wire*-parity case** is now in place (`test/conformance/union-find-absence-parity.test.ts`): the union-find absent variant maps to a 404 ProblemDetails (`/errors/not-found` + `resource: "<Agg>"`) on all six backends. This also fixed a latent Ash bug — the `Order or NotFound` path never compiled, because the `tag_<union>/1` tagger emitted a clause for the error variant referencing a non-existent `%Ctx.NotFound{}` struct (error payloads aren't reified as structs on Ash, and no fixture had ever compiled an error-variant union-find — only `Order or Cancel`, two real aggregate structs). The tagger now emits clauses only for the success (aggregate / value-object) variants; the Ash union-find route reads via the *non-bang* code interface and maps `{:ok, nil}` / `{:error, _}` to the canonical ProblemDetails (mirroring the vanilla foundation). The `resource` extension on the absent body now lands on **all six** backends — .NET can't carry it through `ControllerBase.Problem(...)` (no extension-member slot), so when the payload declares `resource` it builds an explicit `ProblemDetails` + `ObjectResult` and sets `Extensions["resource"]` (`[JsonExtensionData]` → serialized at the body root). | ~~elixir~~ vanilla tail | [exception-less](./exception-less.md) / [vanilla-phoenix-foundation](./vanilla-phoenix-foundation.md) |
| T2.d | **Vanilla/ecto as first-class adapters** — today `elixir/index.ts:~88-94` short-circuits `if (foundation === "vanilla")` instead of routing through the `PersistenceAdapter`/`StyleAdapter` registry like node/dotnet; the headline divergence named by [`../plans/realization-axes-alignment.md`](../plans/realization-axes-alignment.md) (slices #1061–#1064 landed the plan + compatibility rules + transport axis; the rewire itself remains). | elixir, platform | [platform-realization-axes](./platform-realization-axes.md) |
| T2.e | **HEEx walker primitive backfill** — missing: `Tabs`, `Toggle`, `Field`/`NumberField`/`PasswordField`/`MultilineField`/`SelectField` (inputs are HEEx-form-level by design; pack templates exist, walker dispatch doesn't), `For`, `Stat`, `Money`, `Avatar`, `Image`, `Divider`, `Loader`, `Slot`, `Bold`/`Italic`/`InlineCode` (`Switch` left the stdlib — page-metamodel.md subsumed it under `match`; `List`/`Detail`/`MasterDetail` were removed — [D-NO-PAGE-ARCHETYPES](../decisions.md#d-no-page-archetypes)). Unsupported ones render visible `<!-- not supported -->` stubs (`heex-walker-core.ts`). Prioritise `Tabs` + the form inputs. | elixir/heex | [phase-a platform expansion](../plans/phase-a-platform-expansion-prereqs.md) |
| T2.g | **Reified-criteria tail** — capability-`filter` reification: **Hono shipped** (`contextFilterRefs` in the IR; the repo calls the module-level criterion fn) and **Phoenix/Ash shipped** (`renderBaseFilter` references an Ash boolean calculation — `base_filter expr(active)` / `expr(in_region(region: …))` — deduped with find/retrieval consumers via `reifiedCriteriaFor`; build-gated by `criterion-filter.ddd`). The principal/tenancy constructor factory (`currentUser.<field>` as ctor arg — gates T2.j, **excluded from the current run per maintainer**) and ambient (`of bool`) criteria (`src/generator/dotnet/criteria-emit.ts:~64-70`) remain. | ~~elixir~~ principal factory | [reified-criteria](./reified-criteria.md) |
| T2.h | **`shape(document)` on elixir** — `PLATFORM_SAVING_SHAPES` allows `relational`+`embedded` only (`src/util/platform-axes.ts:~127`). | elixir | [document-and-json-hierarchies](./document-and-json-hierarchies.md) |
| T2.i | **IR field-constraint metadata** — ✅ **SHIPPED** (#1214). The shared `singleFieldConstraints` classifier (`src/ir/validate/invariant-classify.ts` → min/max/between/len-*/regex), already consumed by Zod / .NET FluentValidation / the Java validator, is now consumed by elixir's `vanilla/changeset-emit.ts` too — numeric bounds → `validate_number`, length → `validate_length`, regex → `validate_format` on `base_changeset` (no-invariant aggregates stay byte-identical). A FieldIR *data* carrier would duplicate the classifier without new capability — only add it if a consumer needs constraints away from invariant context. | ~~elixir~~ done | [vanilla-phoenix-foundation](./vanilla-phoenix-foundation.md) §validators |
| T2.j | **Principal-referencing context filters on node/elixir/java** — `LIMITED_FAMILIES = {node, elixir, java}` in `validateContextFilterSupport` (`system-checks.ts`); only .NET (`HasQueryFilter`) supports principal/tenancy filters today. **Prereq for — and the first build slice of — multi-tenancy** (the `tenantOwned` filter is principal-referencing; see the D-TENANCY-* decisions). | node, elixir, java | [multi-tenancy-design-note](./multi-tenancy-design-note.md) |
| T2.k | **Provenance + audit runtimes on dotnet/elixir** — DONE for dotnet (`PROVENANCE_BACKENDS = {node, dotnet}`, `AUDIT_OP_BACKENDS = {node, dotnet}`); the .NET backend emits the lineage SDK + co-located column + transactional `provenance_records` flush + wire exposure, and audited operations stage `audit_records` in the save transaction. Elixir still owed (audited lifecycle actions also remain node-only). | ~~dotnet~~, elixir | [provenance](./provenance.md), [audit-and-logging](./audit-and-logging.md) |

## Tier 3 — partially-shipped families (the bigger remainders)

| # | Item | Notes | Owning proposal |
|---|---|---|---|
| T3.1 | **Explicit `loads:` plans** — gated `loom.retrieval-loads-unsupported` (`query-checks.ts:~199`); retrievals load the whole aggregate; no backend consumes a load plan. Explicit narrowing first; auto-inference later. | needs per-backend query emit | [load-specifications](./load-specifications.md) / [retrieval](./retrieval.md) |
| T3.2 | **Criterion selectability tail** — **`when <pred>` + auto-exposed `can-<op>` SHIPPED on all five backends** (409 Disallowed gate + side-effect-free `GET /{id}/can_<op>`; `loom.when-unsupported` now latent). **`Repo.findAll(<Criterion>, page?)` from workflow bodies SHIPPED on every backend** — it desugars (lowering marks a `synthCriterion` `repo-run`; the enrich pass materialises a `findAllBy<Criterion>` retrieval from `ctx.criteria`) so it rides the existing retrieval/`Repo.run` pipeline with no per-backend emitter; validator adds `loom.findall-{unknown-criterion,criterion-mismatch,criterion-arity,no-page}`. Remaining: `from <Criterion>(args)` binding, findAll `sort:`/`loads:` + single-result `Repo.find(<Criterion>)`, `private workflow`. | rides on reified criteria (T2.g) | [criterion](./criterion.md) |
| T3.3 | **Payload P3-full + P5** — nested carriers `P<Q<T>>` (gated `loom.generic-arg-not-carrier`, `generics.ts:~66`); `validate for X` / `authorize for X` (no surface at all). Plus the `unpaged` opt-out + page-aware React hooks. | | [payload-transport-layer](./payload-transport-layer.md) |
| T3.4 | **Exception-less remainder, re-grounded** — with `?` dropped, follow [`failure-taxonomy.md`](./failure-taxonomy.md): route VO-invariant construction failures to 422, `Repo.getById` re-shape (`T or NotFound`, A4 — the one true coordinated-rebaseline moment, old M3), parse/extern as `or` (A5). | A4 = coordinated fixture rebaseline | [exception-less](./exception-less.md) + [failure-taxonomy](./failure-taxonomy.md) |
| T3.5 | **Workflow `repo-let` arrays/nullables** — gated `loom.workflow-load-array-unsupported` / `-nullable-unsupported` (`workflow-checks.ts:~520/~529`). | | [workflow-and-applier](./workflow-and-applier.md) |
| T3.6 | **ES projections + snapshots; workflow-as-aggregate `on(...)`** | after T2.b for elixir parity | [workflow-and-applier](./workflow-and-applier.md) |
| T3.7 | **Channels: realtime wire** — **v1 SSE wire + ui surface SHIPPED on Hono + React** (`delivery: broadcast` → `http/realtime.ts`: `GET /realtime/events` via streamSSE + `realtimeTee` dispatcher decorator composing under the outbox so relayed durable events stream too; React emits the `src/api/realtime.ts` EventSource client when its target backend is Hono; `channel <p>: <Ctx>.<Ch>` + `on <p>.<Event>(e) { toast(…) }` ui members render a RealtimeHandlers component mounted by every pack's App shell — v1 handler body is toast-only, `loom.ui-handler-unsupported`). Remaining: .NET/Phoenix wire, rooms + edge relay + policy-derived router (layer on authorization), external brokers via `channelSource`, `delivery: queue` competing consumers, richer handler actions, Part II caching/invalidation. | router blocked on authorization | [channels](./channels.md) |
| T3.8 | **Transactional outbox** — **Hono + .NET tiers shipped** (`retention: log \| work` → `__loom_outbox` + polling relay/BackgroundService + `event_dead_lettered`; ephemeral stays at-most-once). **Idempotent-consumer markers shipped** (§3: saga rows gain `last_event_id`; the relay threads the outbox row id — `__loomEventId` on Hono, `OutboxDelivery.CurrentEventId` AsyncLocal on .NET — and handler preambles no-op on a repeat, stamping before save; ephemeral contexts stay marker-free). Dapper + event subscriptions now **fails loud** (`loom.dapper-unsupported` — saga handlers/outbox inject the EF AppDbContext the Dapper deployable doesn't emit; previously a silent compile break). Remaining: Phoenix/Oban relay (elixir track), the real Dapper dispatch/outbox path (needs Dapper saga-state persistence first), LISTEN/NOTIFY over polling. | elixir, dapper saga persistence | [dispatch-delivery-semantics](./dispatch-delivery-semantics.md) |
| T3.9 | **Dapper/MikroORM beyond minimal-v1** — expansion in progress on Dapper (maintainer-prioritised): **capability filters + lifecycle stamps + `X id[]` associations + managed-access fields shipped** (filters splice into every SELECT's WHERE; stamps: onUpdate mutates pre-save / onCreate INSERT-only; associations: ordinal-ordered join table + bulk LoadRefsAsync + full-list-replace save; access modifiers are wire-projection concerns — no gate; principal-referencing values stay gated). Remaining dapper gates: nested parts, inheritance, document/embedded shapes, seeds, provenanced fields. MikroORM: decision still needed (expand vs document-as-minimal). | dotnet, node | [storage-and-platform-config](./storage-and-platform-config.md) |
| T3.10 | **Storage tail** — logical `dataSource` bindings (D-STORAGE-SPLIT/D-GRANULARITY), `STORAGE_CAPABILITIES` matrix, reserved `marten`/`layered` stubs. | | [storage-and-platform-config](./storage-and-platform-config.md) |
| T3.12 | **Sensitivity phases 2–4** — `sensitive(tag)` + propagation shipped; `authorized(<tag>,…)` declassification, `mask:` DTOs, sink-call classification absent. | | [sensitivity-and-compliance](./sensitivity-and-compliance.md) |
| T3.13 | **Audit promotion** — `audited` is a boolean (`loom-ir.ts:~314`); promote to `audited(actions \| access \| events \| off)` + `AuditRecord` shape + before/after snapshots + .NET Mediator behaviour. | after T4 execution-context | [audit-and-logging](./audit-and-logging.md) |
| T3.14 | **React frontend remainders** — find-filter list UI shipped (#1125); **frontend-ACL Phase 3 resolved as "keep nested, transform only"** (maintainer decision 2026-06-12: RHF's dots-always-nest semantics make the spec'd flat dot-keys unimplementable; dual `FormState`/`Payload` aliases now emit for transform-bearing actions only — money — with the flat-key restructure + per-action FieldMaps retired to the plan doc's resolved note). Remaining: richer filter inputs (enum select, paged, numeric). | react | [retrieval](./retrieval.md), [loom-forms](./loom-forms.md), [frontend-acl](./frontend-acl.md) |
| T3.15 | **Extern family** — **Tier 2 `action` params SHIPPED** (the `action`/`action(Order)` param type — Loom's first function type — props emit `(arg: OrderResponse) => void`, caller lambda walks in caller scope) and **`function … extern` SHIPPED on React** (ui-member grammar; `src/lib/extern/<f>.signature.ts` + `src/lib/<f>.ts` conformance shim — `tsc` fail-fast; body calls import the shim). Remaining: extern components + functions on LiveView (elixir track), Phoenix `@spec` stage, `hook … extern` (deliberately pulled by a concrete use case per the proposal's staging), void-effect rule (needs a `void` type). | | [extern-component-escape-hatch](./extern-component-escape-hatch.md), [extern-function-hook-escape-hatch](./extern-function-hook-escape-hatch.md) |
| T3.16 | **Resource-kind codegen** — `resource` grammar parses `objectStore \| queue \| api` kinds, but only state/eventLog/replica kinds are actively emitted; the workflow call surface is unstarted. | | [resource-model-and-source-types](./resource-model-and-source-types.md), [workflow-resource-consumption](./workflow-resource-consumption.md) |
| T3.17 | **`hosts:` codegen** — the grammar relation shipped; the embedded-frontend hosting emit (framework moved onto `ui`, host capability check) has not. | | [embedded-frontend-composition](./embedded-frontend-composition.md) |
| T3.18 | **Agent tooling tail** — LSP-provider correctness (§4c) + the playground agentic chat UI (engine fully shipped). | web | [agent-tools-and-mcp](./agent-tools-and-mcp.md) |
| T3.19 | **Seeding tail** — imperative (workflow-shaped) body, per-row natural-key upsert, create-shape validation. | | [database-seeding](./database-seeding.md) |
| T3.20 | **Inheritance I4** — per-concrete storage override / mixed strategy (needs the UNION-ALL read; gated in `validators/inheritance.ts:~137`), polymorphic `<Base> id` refs + `find all <Base>` over TPC. | | [aggregate-inheritance](./aggregate-inheritance.md) |

## Tier 4 — unstarted families (code-verified: no grammar/IR/emit artifacts)

Ordered by the dependency spine, not by size.

1. **execution-context** (Tier-0 backbone) — compiler-emitted scope
   frames (`correlationId`/`scopeId`/`parentId`). **Lands before any
   governance tier**; audit promotion (T3.13), provenance parity
   (T2.k), and authorization all reference it.
2. **multi-tenancy** — design **refined 2026-06-17** (R1–R5; pinned
   **D-TENANCY-SCOPE / -REGISTRY / -DEFAULT / -HIERARCHY**): `tenancy by
   user.tenantId of Organization`; **two-value** scope (`with tenantOwned`
   / `crossTenant`; **no `platform` scope**); **no silent default** (unmarked
   = unscoped + an explicit-stance lint, recommend `error`); registry =
   `implements "tenantRegistry"` capability (provides immutable `parent` +
   `dataKey`; **reparent out of scope**); always hierarchy-ready with `dataKey`
   stamped from the token (so `deep` is migration-free); depth
   `local`/`deep`/`global` is a **per-role authz access level**. Ships
   **before** authorization Phase 1 (DataKey leftmost = TenantId). **Prereq +
   first build slice: T2.j** — principal-referencing context filters on
   node/elixir/java (the `tenantOwned` filter *is* principal-referencing).
   Delivery is capability-first (rides D-TYPED-CAPABILITIES, or the existing
   string capability in the interim).
3. **authorization** phases 1–4 (`DataKey`, `policy { data /
   operations / fields }`, gates; D-POLICY-STYLE pinned). Phases 5–7
   deferred tail.
4. **domain-services** (`domainService`, design pinned #1058 —
   `DomainServiceIR`, `callKind: "domain-service"`, Shape A pure
   calculator first).
5. **loom-forms** (typed-action `CreateForm`/`OperationForm`/
   `DestroyForm` binding — fixes the form/API create-contract layering
   bug; lifecycle Phase 1 prereq is done) + **lifecycle-operations
   Phase 2+** (full action surface, `crudish` reframe) — the
   `urlStyle`/`routeSlug` base is shipped.
6. **i18n-strings → i18n** phases 1–7 (ICU catalogs, content-hash
   keys, `ddd i18n sync`; D-I18N-KEY pinned).
7. **quickstart-and-day-one-batteries** — `ddd dev` / `ddd deploy`,
   turnkey OIDC `auth` (D-AUTH-OIDC; replaces the per-backend
   `verify_token`/verifier stubs), `job` / `email` / object `storage`.
8. **Deployment & networking** — deployable-networking (`serves … at`
   address binding), multi-target-proxy (approved, impl pending),
   kubernetes-helm, terraform-iac (research).
9. **Structural reframes** — bounded-context-model,
   per-package-output-tree (deferred on fixture/CI cost),
   unfoldable-api-derivation (coordinate with payload P2 before
   building more on `wireShape`), and **typed-capabilities**
   (**D-TYPED-CAPABILITIES**, new 2026-06-17) — promote the stringly-typed
   `implements "X"` / `filter for` / `stamp for` surface to a first-class
   pure-mixin `capability` declaration; **byte-identical** migration;
   subsumes the `audit`/`softDelete` macros (`crudish`/`scaffold*` stay
   macros). Low-risk and independently landable; the
   `tenantOwned`/`tenantRegistry` capabilities are its first clients.
10. **java-backend** — **SHIPPED** (#1110 + follow-ups; execution
    record in `../plans/java-backend-implementation.md`).  Landed as
    planned on the reified `Specification<T>` model and the
    `ExprTarget`/`WalkerTarget` seams — the first backend consuming
    `CriterionIR` directly.

## Coordinated single-PR moments (surviving set)

| Tag | What | Why one PR |
|---|---|---|
| A4 rebaseline | `Repo.getById` re-shape to `T or NotFound` (T3.4) | One coordinated fixture re-baseline across all backends (the old "M3") |
| Tier-0 | execution-context before audit/auth tiers | Audit-record backbone |
| Auth-gate | multi-tenancy before authorization Phase 1 | DataKey leftmost = TenantId |
| ES-vanilla | T2.b lands as one slice over the vanilla repo seam | Stream table + fold + create-from-event must agree |

The old **M1** (P3+P4 together) and **M2** (A1+A2+A3 together) are
retired: P4 and most of A1/A3 shipped independently, and A2 is dropped.

## Suggested near-term order

A pragmatic order, dependency-consistent (T2.a / T2.b / T2.c / T2.e / T2.i all
✅ shipped; ES VO/enum applier folds ✅ #1212):

1. **ES-on-vanilla tail (P4.4)** — ✅ done: the T2.c returning-op tail (guard/emit
   bodies + success serialization #1221) and the cross-backend *wire*-parity case
   (the union-find absent variant 404s uniformly across all six backends, with the
   `resource` extension on the body everywhere — .NET via an explicit `ProblemDetails`
   + `ObjectResult`) both shipped.
2. **T2.g residue** — Phoenix capability-`filter` reification (elixir
   track); principal factory excluded per maintainer.
3. **T3.1** explicit `loads:` plans.
4. **Tier 4 #1–#3** execution-context → multi-tenancy → authorization
    — the governance spine.

## Parallelisation

Three loosely-coupled tracks (one agent each):

- **Track A (type-system & queries):** T2.g → T3.1/T3.2 → T3.4.
- **Track B (elixir parity):** T2.a → T2.b → T2.c → T2.d → T2.e/T2.h.
- **Track C (governance & product):** T2.i →
  execution-context → multi-tenancy → authorization; loom-forms +
  frontend remainders interleave.

## Verification

- Every tier-1/2 item: the fast suite (`npm test`) + the owning
  backend's build gate (`LOOM_TS_BUILD` / `LOOM_DOTNET_BUILD` /
  `LOOM_PHOENIX_BUILD` / `LOOM_REACT_BUILD`) + byte-identical fixtures
  unless the item *is* a rebaseline.
- Cross-backend wire items (T2.c, T3.4): the conformance parity
  gate (`conformance-parity.yml`) is the decisive check.
- Elixir items: `mix compile --warnings-as-errors` runs in CI only
  (no local toolchain) — keep slices small, push often, treat
  `elixir-ash-build.yml` / the vanilla fixture job as the acceptance
  gate.
- Gate removals (e.g. T2.b/T2.c widening a `*_BACKENDS` set): the
  negative validator test moves, it does not disappear — assert the
  remaining unsupported backends still fail fast.
