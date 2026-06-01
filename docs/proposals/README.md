# Loom proposals — index

This directory is the live design corpus for Loom. Each doc is a
single self-contained proposal (problem → proposed surface → grammar
additions → lowering semantics → open questions). Some are shipped,
some are partial, most are still on paper.

**Authoritative ordering lives in
[`global-implementation-plan.md`](./global-implementation-plan.md)** —
it audits the codebase against `origin/main`, resolves
cross-proposal collisions, and pins a topological order across the
whole corpus. The phase summary in this README is a précis; the
plan doc is the source of truth.

**Pinned decisions live in [`../decisions.md`](../decisions.md)** —
when a D-tag (e.g. D-STORAGE-SPLIT, D-GRANULARITY, D-RENAME,
D-LIFECYCLE-VERB, …) is referenced from a proposal or plan, the
decisions log is where the binding answer lives. Proposal text that
predates a pinned decision is annotated with a "Pinned decisions
affecting this proposal" block at its top.

This README is hand-maintained and was previously stale. If you
spot drift between a proposal's actual status and the table here,
update both the entry and `global-implementation-plan.md`.

## Status legend

| Tag | Meaning |
|---|---|
| **SHIPPED** | Lives on `origin/main`. Deltas only from here. |
| **PARTIAL** | Some phases shipped; remaining phases tracked in the doc. |
| **PROPOSED** | No code yet. Grammar/IR/semantics specified. |
| **SUPERSEDED** | Replaced or reframed by a newer proposal. Read for background only. |
| **DEFERRED** | Design recorded, implementation not scheduled. |
| **REFERENCE** | Cross-cutting plan or overview, not itself a feature. |

Status reflects `origin/main` as of the last refresh of
`global-implementation-plan.md`'s audit table.

## Every proposal in this directory

### Reference & planning

| Doc | Status | Role |
|---|---|---|
| [`global-implementation-plan.md`](./global-implementation-plan.md) | REFERENCE | Topological ordering across the whole corpus; audits against `origin/main`; pins decisions; lists coordinated single-PR moments (M1/M2/M3, etc.). Start here for "what's next". |
| [`implementation-plan.md`](./implementation-plan.md) | REFERENCE | Stacked delivery plan for the type-system family (aggregate-inheritance + payload-transport + exception-less + criterion). Phase-by-phase, dependency-explicit. Consumed by Phase 2 of the global plan. |
| [`type-system-overview.md`](./type-system-overview.md) | REFERENCE | 10-minute orientation across the type-system family. Read first if you're picking up any of P/A/Crit. |
| [`production-readiness.md`](./production-readiness.md) | REFERENCE | Roadmap naming the scaffold→system gap (bounded reads, deny-by-default, async messaging/outbox, caching, search projections, account management, i18n, k8s emit, ops surface, inter-service calls). Cross-references the per-feature proposals and flags which still need one. |
| [`storage-and-platform-config-plan.md`](./storage-and-platform-config-plan.md) | REFERENCE | 14-phase, 17–19 PR build order for the storage proposal. Consumed by Phase 1A. |
| [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) | REFERENCE | Foundation-first sub-plan (skeleton-only delivery, ~22 days serialised, F1 broken into 6 small PRs). Consumed by Phase 1A. |

### Structural & layout

| Doc | Status | Aspect |
|---|---|---|
| [`bounded-context-model.md`](./bounded-context-model.md) | PROPOSED | **Reframes the structural model.** Promotes the bounded context to the central organising unit; adds a subdomain layer; clarifies BC vs module vs deployable. **Supersedes the per-aggregate-storage granularity of the three `storage-and-platform-config*.md` docs** (the grammar work mostly survives — the *granularity* is what changes; persistence binds at BC level, not per-aggregate). |
| [`src-ir-phase-reveal.md`](./src-ir-phase-reveal.md) | SHIPPED | Restructured `src/ir/` into `types/` / `lower/` / `enrich/` / `validate/`; moved `migrations-builder.ts` to `src/system/`. |
| [`test-layout-and-macro-consolidation.md`](./test-layout-and-macro-consolidation.md) | SHIPPED | Test tree mirrors `src/` phases; macros consolidated under `src/macros/`. |
| [`platform-directory-layout.md`](./platform-directory-layout.md) | PROPOSED | Framework-version axis for backend code (`hono@v4`→`v5`, `net8`→`net10`, Ash 3→4). **Option A (reverse the hono hoist) is rejected per [D-BACKEND-PKG](../decisions.md#d-backend-pkg--per-version-backend-packages-are-canonical).** The surviving direction is per-`<family>/v<N>/` homes that stage toward the packaging-split's per-version packages; adapters move to the backend surface per [D-ADAPTER-HOME](../decisions.md#d-adapter-home--persistencestylelayout-adapters-live-on-the-backend-surface). |
| [`per-package-output-tree.md`](./per-package-output-tree.md) | PROPOSED (deferred) | Per-layer **output** packages (`-domain`/`-dal`/`-api`/`-contracts`/`-ui`) — the "Loom as ORM" enabler. Output-side twin of the packaging split; expressible as a `LayoutAdapter` extension. Right direction, deferred on one-time fixture/CI cost + the playground-workspace prerequisite — not on value. |

### Storage & platform config

| Doc | Status | Core addition |
|---|---|---|
| [`storage-and-platform-config.md`](./storage-and-platform-config.md) | PARTIAL | Top-level `storage <name> { type }` and deployable role-keyed slots shipped. Remaining: per-aggregate `persistenceStrategy:`, logical bindings (now `dataSource` per [D-STORAGE-SPLIT](../decisions.md#d-storage-split--split-the-overloaded-storage-keyword)), per-deployable `style:` / `layout:` / `persistence:`, `STORAGE_CAPABILITIES` matrix, adapter contracts. Granularity is per-context, not per-aggregate ([D-GRANULARITY](../decisions.md#d-granularity--storage-bindings-are-per-context-not-per-aggregate)); per-aggregate `for:` deferred to v2 override. |

### Deployment & infrastructure

| Doc | Status | Core addition |
|---|---|---|
| [`kubernetes-helm.md`](./kubernetes-helm.md) | PROPOSED | Emit a Helm chart (+ the raw k8s manifests it renders to) alongside `docker-compose.yml`, as a new `src/system/` artifact sibling. **Emitter-only** (no grammar/IR change in v1); database assumed **external/managed** (connection `Secret`, no in-cluster postgres); tuning lives in `values.yaml`. Reverses the stated non-goal in `docs/tools.md:324` / `docs/generators.md:764`. Defers infra-in-DSL (`replicas`/`resources`/`ingress` clauses) and a per-platform `workloadShape` surface method to follow-ups. |

### Backends & code generation

| Doc | Status | Core addition |
|---|---|---|
| [`elixir-ecto-and-api-only-backends.md`](./elixir-ecto-and-api-only-backends.md) | PROPOSED | Effort/shape study for three backend-matrix additions: a non-Ash Elixir/Phoenix/**Ecto** full-stack generator, plus **API-only** flavours of both the Ash and Ecto backends (JSON surface consumed by the React frontend). Grounds each in the `PlatformSurface`/adapter/conformance machinery: the **Ecto domain layer** is the dominant cost (hand-built `Ecto.Schema`/`Ecto.Changeset`/context modules vs Ash's declarative resources); the HEEx walker, `MigrationsIR`→Ecto migrations, and the existing JSON+OpenAPI surface are **reuse**; API-only is a cheap *UI-absent strip* of a full backend. Recommends a sibling `phoenix` platform for the Ash/Ecto axis (Option B) over an adapter swap (Option A, later) or `family@version` (rejected). **Investigation (§2.1) resolves D-API-ONLY**: the generator already emits a clean API-only project when no `ui` is bound (`liveview-emit.ts:61`), so API-only is absence-of-a-`ui`-mount, not a new platform — the only gap is React's `apiBaseUrl` needing an `/api` branch for a Phoenix target + a CORS plug. Still requests **D-PHOENIX-ECTO**. |
| [`embedded-frontend-composition.md`](./embedded-frontend-composition.md) | PROPOSED | Decouples the served UI from the backend platform. Today the UI framework is **derived from the host** and the embed is hardwired to React at three layers (generator `dotnet/index.ts:274`; validator `expectedFrameworkFor` `platform-rules.ts:94`; grammar `Framework` enum), so `dotnet`-embeds-Angular / `phoenix`-embeds-React are **inexpressible**. Fix: move **framework/design/stack onto the `ui` declaration** (no separate `frontend` citizen — folded in per the chat decision), and make hosting an explicit relation — a `deployable` **`hosts:`** a `ui`, with **embedded-vs-standalone derived from the host's `needsDb`** (vite/static serve standalone + `targets:` a backend; dotnet/phoenix/hono embed). Host-compatibility is a principled capability, not a lookup table: a host can serve a `ui` **iff it provides the runtime that framework requires** (react → static assets, hostable anywhere; liveview → phoenix runtime only). Unmasks `platform: react` as "Vite hosts React" and retires it as a platform. The rare one-ui-two-frameworks case is deferred to the host edge (`hosts+=[Ui]` is a list from day one). Success test: adding a host×framework pairing touches the framework generator + a capability set, **never** the host's serving code. **Phoenix is the keystone (§6):** `phoenixLiveView` froze *two* axes — domain (Ash/Ecto, freed by the Ecto note) **and** hosted framework (LiveView/React, freed here) — so it decomposes to `phoenix` × domain × framework. Phoenix gets the richest `hostableFrameworks` (`{liveview} ∪ {react,…}`) *derived* from being the only platform that's both a render runtime and a static-asset host (`priv/static`), which unlocks **Phoenix-embeds-React** (the `wwwroot` twin) for free. Complementary to the Ecto note on the same keyword; both converge on `react/index.ts:48–52`. |

### Documents & JSON hierarchies

| Doc | Status | Core addition |
|---|---|---|
| [`document-and-json-hierarchies.md`](./document-and-json-hierarchies.md) | PARTIAL — surface + IR landed (Slices A/B/C, #703/#711/#713); document-persistence emission (Slice D: Marten / EF `.ToJson()`) not started | Persisting hierarchies as JSON documents (Marten / EF Core `.ToJson()` / Mongo-embedding analogues) instead of normalised tables. Separates open-shape `json` field (need A) from document-mapped typed hierarchy (need B). **Chosen direction:** two orthogonal per-aggregate header axes — a **truth kind** `persistedAs(eventLog | state)` (renamed from the shipped body `persistenceStrategy:`; values aligned to the `dataSource` `kind` set; carries the validated apply-always body contract) × a **saving shape** `normalised(true | false)` (new; `false` = document) — so the required **`persistedAs(eventLog)` + `normalised(false)`** (stream + document snapshot, Marten's sweet spot) is expressible. Wired via `normalised: false` on the `snapshot`/`state` `dataSource` + a Marten `PersistenceAdapter`. Plus a `json` primitive for open-shape data. Header-syntax reconciliation: all aggregate config on the header as paren modifiers, nothing in the body; amends D-RENAME (`inheritanceStrategy` → `inheritanceUsing`, colon→paren) and relocates/renames the shipped body `persistenceStrategy:`. Drops the per-containment hint; rejects "document as aggregate peer". Requests **D-DOCUMENT-AXIS**. |

### Type-system family — state, transport, exception-less, criterion

> **Start here**: [`type-system-overview.md`](./type-system-overview.md).
> The proposals total ~3000 lines; the overview is 10 minutes.

| Doc | Status | Core addition |
|---|---|---|
| [`aggregate-inheritance.md`](./aggregate-inheritance.md) | PARTIAL — I1 shipped (surface + IR + validators; no emission) | Abstract aggregates with single inheritance; storage strategies `sharedTable`/`ownTable` (the `inheritanceUsing(…)` header modifier per D-RENAME). Nominal, no generics. Independent track. Remaining: I2 (TPH emission), I3 (TPC emission), I4 (override + TPT-via-`contains` docs). |
| [`payload-transport-layer.md`](./payload-transport-layer.md) | PROPOSED | `payload` umbrella over events/commands/queries/responses/errors. Carrier-bounded generics with ML-postfix syntax (`customer page`). Named (`payload Foo = A \| B`) and anonymous `or` unions. Auto-synthesised aggregate wire payloads. Foundation for the whole family. |
| [`exception-less.md`](./exception-less.md) | PROPOSED | `error` payloads (HTTP-blind in the domain). `option` ML-postfix sugar. `?` propagation operator. `Repo.getById` re-shape to `T or NotFound`. Per-api `status` mapping + stdlib defaults driving auto-generated RFC 7807 ProblemDetails. Two-regime split (aggregate-throws vs boundary-returns-carrier). No `Result<T, E>` wrappers. |
| [`criterion.md`](./criterion.md) | PARTIAL | `criterion <Name>(args) of T = <bool expr>` (Spring-Data / Evans style). **Core shipped**: declaration, body validation (purity / queryable / cycle / arity), and compile-time inline into every existing boolean-expression position (`view`/`find` `where`, invariants, operation preconditions) — composition via `&&`/`||`/`!` for free, no backend query-engine change. See [`docs/criterion.md`](../criterion.md). **Deferred** (need exception-less + payload-transport): `from <Criterion>(args)`, `when <Criterion>` + auto-exposed `can-<op>`, built-in `Repo.findAll(criterion, sort?, page?, loads?)`, `private workflow`. Resolves D23. |
| [`reified-criteria.md`](./reified-criteria.md) | PROPOSED | **Reverses "inline everything" for criteria.** A criterion is a **constructed Specification object** (spec + factory + consumer), not a use-site-substituted `ExprIR`; backends consume `CriterionIR` directly. `currentUser.<field>` becomes an ordinary **constructor argument** resolved from the principal at construction — removing the two-mechanisms smell (find-param threading vs injected accessor). Makes selection↔validation **structural** (`toExpression()` + `isSatisfiedBy()` on one object). Supersedes the *mechanism* of the inline criterion work (its selectability + enforcement semantics survive); the Java `Specification<T>` emission is this on a 4th backend. |
| [`retrieval.md`](./retrieval.md) | PROPOSED | The **named query bundle**: `retrieval <Name>(args) of T { where: <criteria> sort: … loads: … }`, run via `Repo.run(R(args), page?)`. `criterion` is the predicate atom; `retrieval` is the bundle (predicate + sort + loads). `where`/`sort`/`loads` are the named rule; **`page` is call-site only**. Deliberately avoids the name "Specification" (the atom on JPA, the bundle on .NET/Ardalis) — lowers to `RetrievalIR` + `LoadPlanIR` (default `whole(agg)`). Graduates the seam from `reified-criteria.md`. |
| [`partial-update.md`](./partial-update.md) | PROPOSED | `command` + `T option` fields for PATCH semantics. Supersedes the v0 `Optional<T>` proposal. **Folded into A1** of the implementation plan. |
| [`load-specifications.md`](./load-specifications.md) | PROPOSED | `loads` clause + compiler-inferred load plans + shape (loadedness) typing. **Folded into P3** of the implementation plan. |

### Aggregate lifecycle + forms

Tightly coupled pair: aggregate action surface and the form-generation
layer that consumes it.

| Doc | Status | Core addition |
|---|---|---|
| [`lifecycle-operations.md`](./lifecycle-operations.md) | PROPOSED | Three keywords on aggregates (`create [name]`, `operation name`, `destroy [name]`) with kind-tagged typed actions; framework-owned persistence; body operating on pre-bound `this`. Drops PATCH (POST for body-carrying actions, DELETE only for canonical destroy). API-layer `urlStyle: literal \| resource`. Reframes `crudish` to emit the canonical lifecycle trio. Rejects: lifecycle-on-service, per-operation route alias, generic action kind, `delete` keyword. |
| [`loom-forms.md`](./loom-forms.md) | PROPOSED | `CreateForm` / `OperationForm` / `DestroyForm` walker primitives binding strictly to typed actions defined by `lifecycle-operations.md`. The action's param list IS the form's field list — no field-walking fallback. Submission dispatches via the generated API client. Fixes the layering bug where form walker + API generators independently synthesise the create contract. |
| [`frontend-acl.md`](./frontend-acl.md) | PARTIAL | Frontend Anti-Corruption Layer: two shared utility files emitted into every React project (`src/lib/strict-field-map.ts` — compile-time `StrictFieldMap<P, F>`; `src/lib/apply-server-errors.ts` — runtime decoder that returns `ServerErrorOutcome` `applied`/`global`/`unhandled`). Generated form catch blocks across all 8 pack/versions (mantine v7+v9, shadcn v3+v4, mui v5+v7, chakra v2+v3) call `applyServerErrors` with `setError` + an empty (identity) FieldMap, then switch on the outcome for pack-native toasts. Behaviourally additive — the `applied` per-field path is dormant until backends grow the RFC 7807 §3.2 `errors[]` extension (lands with `exception-less.md`). **Shipped Phases 1+2 in #769**. Deferred: schema restructure (flat-key + `.transform()` + `<Action>FormState` ≠ `<Action>Payload`) and per-action FieldMap instances (meaningless until the restructure), `option`-field rendering (gated on `partial-update.md`). |
| [`extern-component-escape-hatch.md`](./extern-component-escape-hatch.md) | PROPOSED | UI-side analogue of `operation … extern` (`docs/extern.md`): an `extern` modifier on `component` lets users drop a **hand-written React/TSX (or HEEx) component** into a page body, type-checked against the domain via a `wireShape`-derived props interface that Loom regenerates every run. **No stub, no write-once** — the user's component is *never* generated, only imported (like an `import helper` target), so `tsc` on a missing/mismatched component is the fail-fast gate and there is no first-run magic (`tools.md:119`). Opens the closed walker library (`page-metamodel.md` §9) at one controlled, typed seam — extern components are typed *leaves* the walker renders but never descends into, not new primitives. **Interactive from v0 via `slot`** (not a read-only widget): the caller passes a fully-wired `Action{…}` into a slot param, handed to the hand-written component as a `ReactNode` — a real domain-wired control with no new machinery. **Recommended delivery is staged** (see the proposal's §4): ship **Tier 1 (slot), React only**, gated on a `LOOM_REACT_BUILD` test proving a domain rename breaks the user's `.tsx` at the props boundary (the feature's whole point); **defer Tier 2** — `action` behaviour params (`o => { o.confirm() }` lowered to a `(args)=>void` callback, the element-vs-callback sibling of `slot`) — until a concrete widget pulls it, because it adds Loom's *first function type*; **defer LiveView** likewise. No op-specific binding form; no call-site inference (Loom types declarations, checks uses — `type-system.ts:417`), so the eventual `action` token is `action(Order)` (preferred) vs `(Order) => action`. Don't ship import-only (A) as the end state — it discards the `wireShape` type that is the reason to do this in a typed DSL. **`extern page` is explicitly declined** (§10): a page is a composition point (route+params+auth+menu+body), not a leaf — its body already escapes via an extern component, and owning the whole route module is what the file-level `.loomignore` hatch is for. Composes with `embedded-frontend-composition.md` (framework on `ui`). |

**Read order:** lifecycle-operations first (foundation); forms second; frontend-acl third (form runtime); extern-component-escape-hatch alongside (the open-library seam, independent of the form family).

### Workflow

| Doc | Status | Core addition |
|---|---|---|
| [`workflow-and-applier.md`](./workflow-and-applier.md) | PROPOSED | Reframes today's `workflow Name(params) [transactional]`. Introduces appliers (`apply(...)`) for event-sourced aggregates and workflows. Three concepts split out of today's overloaded `workflow`: single-tx command handler, multi-tx command-triggered process, event-triggered process. Sagas (compensation contract) deferred to a v2 amendment. |

### Provenance & governance family

> The umbrella term is **value provenance** — "explain where a
> computed value came from", aligned with W3C PROV. Classic
> requirements-tracing was considered and set aside in favour of
> this.

| Doc | Status | Core addition |
|---|---|---|
| [`provenance.md`](./provenance.md) | SHIPPED (TS/Hono v1) | `derived … provenanced` + compiler-inferred lineage + snapshot/trace split. .NET/Phoenix parity is Phase 5 deferred tail. |
| [`execution-context.md`](./execution-context.md) | PROPOSED | Compiler-emitted scope frames (`correlationId`/`scopeId`/`parentId`/…) shared by provenance, audit, and logging. Tier 0 of Phase 3 — backbone for everything that follows. |
| [`audit-and-logging.md`](./audit-and-logging.md) | PARTIAL | `audited` boolean shipped; Hono emits load→mutate→save→audit. Remaining: promote to `audited(actions \| access \| events \| off)`, `AuditRecord` shape, before/after snapshots, .NET Mediator behaviour, access-audit query pipeline. |
| [`observability.md`](./observability.md) | SHIPPED | Structured logging via IR-neutral event catalog. Catalog + 3 backends + `LOOM_OBS_E2E_*` gates green on main. Complementary to `audited` — observability is the structured-log channel, `audited` is the transactional append-only one. |
| [`sensitivity-and-compliance.md`](./sensitivity-and-compliance.md) | PARTIAL | `sensitive(<tag>)` as a type-system property; sensitivity propagates through expressions. Phases 1 + 2-lite shipped. Remaining: Phase 2 full (`authorized(<tag>, …)` declassification), Phase 3 (`mask:` DTOs + React), Phase 4 (sink-call classification — log/error/trace/metric reject sensitive values). |
| [`encrypted-at-rest.md`](./encrypted-at-rest.md) | DEFERRED | Reserved sibling of `sensitive` — governs *persistence*, not *flow*. Final phase of Phase 5; gated on storage capability matrix. |
| [`policies-supplementary-note.md`](./policies-supplementary-note.md) | SUPERSEDED | Background only. Superseded by `authorization.md`. |

### Authorization & tenancy

| Doc | Status | Core addition |
|---|---|---|
| [`authorization.md`](./authorization.md) | PROPOSED | `DataKey` hierarchical scoping; `policy { data { … } operations { … } fields { … } }` reachability, operation/view/workflow gates, field masking. Pinned per D-POLICY-STYLE over the function-style alternative. Phases 1–4 in Phase 3.2; phases 5–7 (`exists`, field rules, `implies`) in Phase 5. |
| [`multi-tenancy-design-note.md`](./multi-tenancy-design-note.md) | PROPOSED | `tenancy by user.tenantId` at system level; `crossTenant` / `platform` aggregate modifiers; auto-stamped `TenantId` column + EF/Drizzle/Ash query filter. Ships before authorization phase 1 (DataKey leftmost = TenantId). |

### On-ramp & day-one runtime

| Doc | Status | Core addition |
|---|---|---|
| [`quickstart-and-day-one-batteries.md`](./quickstart-and-day-one-batteries.md) | PROPOSED | Collapses zero-to-running into `ddd new` + npm publish + a quick-start stack default; adds a unified `ddd dev` watch/regenerate/live loop and a one-command `ddd deploy <target>` (Fly/Render/Railway) over the existing Dockerfiles + compose + per-deployable DBs; and the universal runtime constructs the model can't express today — turnkey `auth { providers }` with login/signup UI + sessions + default-deny (completing `auth.md`'s known holes), `job` (scheduled/event-triggered), `email`, object `storage` + `File`/`Upload`, and `seed`. Strictly additive; opt-in models emit byte-identically. |

### UX / output

| Doc | Status | Core addition |
|---|---|---|
| [`pagination-design-note.md`](./pagination-design-note.md) | PROPOSED | `Paged<T>` response envelope; offset/limit defaults; `unpaged` opt-out for small reference lists. Phase 4.2. |
| [`i18n-strings.md`](./i18n-strings.md) | PROPOSED | String composition: template literals, ICU, concatenation ban in user-visible slots. Closes `i18n.md` open question #4. Companion — must read with `i18n.md`. |
| [`i18n.md`](./i18n.md) | PROPOSED | First-class i18n: ICU catalogs, content-hash keys, named `text { }` entries, `ddd i18n sync` three-way merge, per-backend adapters. 7-phase build, ~4 weeks. Phase 4.1. |

### Quality / tooling

| Doc | Status | Core addition |
|---|---|---|
| [`playground-git-vfs.md`](./playground-git-vfs.md) | SHIPPED | Browser playground filesystem is git-native: LightningFS + isomorphic-git durable store, async workspace layer over it (sync resident snapshot for LSP/editor), one-time legacy-IDB import, generated code versioned under `/workspace/generated/**` with regeneration as a per-file 3-way merge, debounced commit-on-save. `web/`-only. Landed in #748 (+ preview-from-workspace), #757 (commit-on-save + race guard + scoped scan), #761 (cleanup). Plan: [`../plans/playground-git-vfs-implementation.md`](../plans/playground-git-vfs-implementation.md). Deferred: in-editor conflict-marker indicator. |
| [`mutation-testing.md`](./mutation-testing.md) | PROPOSED (OUT OF SCOPE) | IR-level `ExprIR → ExprIR[]` operators; gated instrumented emit mode preserving byte-identical fixtures; staged runner plan. Excluded from the global plan per maintainer. |

## Phase summary (precis of global plan)

```
Phase 0 — Convenience & architectural groundwork (decisions + docs)
  0.1 Decisions to pin (D-RENAME, D-STORAGE-SPLIT, D-POLICY-STYLE,
      D-LIFECYCLE-VERB, D-I18N-KEY, D-CTX-SHAPE, D-ENVELOPE,
      type-system D1–D4 + D14–D15)
  0.2 Mechanical reorgs — DONE (src-ir-phase-reveal,
      test-layout-and-macro-consolidation)
  0.3 Seam extractions — partially done; remaining seams listed
  0.4 Cross-cutting design specs at docs/architecture/*.md
      (request-context, wire-envelope, modifier-propagation,
      diagnostic-catalog, cli-surface, coordinated-rebaseline)
  0.5 (deferred)
  0.6 Decision log + PR-type taxonomy

Phase 1 — Three parallel foundation tracks
  1A Storage & platform-config foundation (depends on D-STORAGE-SPLIT
     and bounded-context-model.md granularity decision)
  1B Lifecycle-operations + loom-forms
  1C Aggregate inheritance (Track I)

Phase 2 — Type-system family (per implementation-plan.md)
  2.1 Payload-transport (P1–P5)        — M1 = P3+P4 together
  2.2 Exception-less (A1–A7a)          — M2 = A1+A2+A3, M3 = A4 alone
  2.3 Criterion (Crit1–5)
  2.4 partial-update folded into A1; load-specifications into P3

Phase 3 — Provenance & governance
  3.0 execution-context (Tier 0 backbone)
  3.1 Tier 1 — audit promotion + sensitivity phases 2/3/4
  3.2 Tier 2 — multi-tenancy → authorization phases 1–4
              (wires policyDecisionId into Tier 1 audit records)

Phase 4 — i18n + pagination
  4.1 i18n-strings → i18n phases 1–7
  4.2 pagination-design-note

Phase 5 — Deferred tail
  Authorization phases 5–7
  Provenance v1 across .NET / Phoenix
  Audit module-wide config
  encrypted-at-rest
```

### Coordinated single-PR moments

| Tag | What | Phase |
|---|---|---|
| D-RENAME | `inheritanceUsing(sharedTable \| ownTable)` (amended by D-DOCUMENT-AXIS) | 0.1 |
| D-DOCUMENT-AXIS | `persistedAs(…)` + `normalised(…)` header axes; `json` field | 0.1 |
| D-STORAGE-SPLIT | Split overloaded `storage` keyword | 0.1 |
| D-POLICY-STYLE | `policy {}` over function-style | 0.1 |
| D-LIFECYCLE-VERB | `urlStyle:` default | 0.1 |
| D-I18N-KEY | Option B placeholder lowering | 0.1 |
| F1-PR-5 | `STORAGE_CAPABILITIES` + adapter stubs | 1A |
| F3 | Adapter contract publication | 1A |
| Lifecycle-1 | Grammar + `OperationIR.kind` | 1B |
| M1 | P3 + P4 ship together | 2.1 |
| M2 | A1 + A2 + A3 ship together | 2.2 |
| M3 | A4 alone with fixture rebaseline | 2.2 |
| Tier-0 | execution-context before audit/auth tiers | 3.0 |
| Auth-gate | multi-tenancy before authorization phase 1 | 3.2 |

### Parallelisation

Two-agent split per the global plan:

- **Agent A** — Phase 0 seams → Phase 1A (storage) → Phase 2 → Phase 3.2 (auth)
- **Agent B** — Phase 0 reorgs → Phase 1B (lifecycle + forms) and/or 1C (inheritance) → Phase 3.0 → Phase 3.1 → Phase 4

After the storage adapter contract (F3) publishes, additional
implementers can absorb storage post-foundation streams A–O in
parallel.

## Cross-proposal coordination notes

- **bounded-context-model.md vs storage proposals.** Pinned via
  [D-STORAGE-SPLIT](../decisions.md#d-storage-split--split-the-overloaded-storage-keyword)
  + [D-GRANULARITY](../decisions.md#d-granularity--storage-bindings-are-per-context-not-per-aggregate):
  three keywords (`storage` physical, `dataSource` per-context+kind,
  `deployable.dataSources:` binding clause); per-context for v1,
  per-aggregate deferred. The storage proposal's grammar work
  largely survives; per-aggregate `for:` does not land in v1.

- **aggregate-inheritance.md ↔ storage.** Original
  `storage: shared | own` for inheritance table layout collides
  lexically with the storage proposal's `storage` keyword. Pinned
  rename (D-RENAME, amended by D-DOCUMENT-AXIS §4): the header paren
  modifier `inheritanceUsing(sharedTable | ownTable)`. A
  `persistedAs(eventLog)` concrete subtype of a `sharedTable` abstract
  is forced to `inheritanceUsing(ownTable)` (D-ES-TPH).

- **Storage foundation positioning.** The storage micro-plan's
  foundation phases are positioned to land **before** the type-system
  family's exception-less A4 phase. The
  `PersistenceAdapter.emitRepository(...)` contract is stable under
  A4 — landing the seam first reduces A4's per-backend monolithic
  edits to per-adapter file edits.

- **Authorization vs multi-tenancy.** They overlap on the
  `crossTenant` keyword and tenancy primitives; reconciliation is
  tracked in §0 of `authorization.md`. `policies-supplementary-note.md`
  is retained as background but superseded by `authorization.md`.

- **Sensitivity / audit / load-spec ↔ authorization.** Sensitivity
  tags drive a policy-presence lint; audit records reference a
  policy decision id; the load-spec layer and any data-policy
  filtering both wrap `Repo.load`.

- **lifecycle-operations ↔ workflow-and-applier.** Both touch the
  action surface. Lifecycle-operations covers aggregate-local typed
  actions; workflow-and-applier reframes context-level orchestration
  and adds appliers. Read the lifecycle doc first; the workflow doc
  builds on its `OperationIR.kind` tagging.

- **platform-directory-layout / per-package-output-tree ↔
  packaging-split.** Backend layout is governed by
  [`docs/plans/packaging-split.md`](../plans/packaging-split.md)
  (per-version installable backend packages), pinned canonical by
  [D-BACKEND-PKG](../decisions.md#d-backend-pkg--per-version-backend-packages-are-canonical).
  This **rejects** `platform-directory-layout.md`'s Option A (reversing
  the `src/platform/hono/v4/` hoist) — that hoist is the package-staging
  shape, guarded by the live `package → shared` invariant
  (`test/platform/backend-packages-layering.test.ts`). Adapters move
  onto the backend surface and the central `adapter-registry.ts`
  dissolves per
  [D-ADAPTER-HOME](../decisions.md#d-adapter-home--persistencestylelayout-adapters-live-on-the-backend-surface);
  the F5d/F6d orchestrator rewire already decentralised the emit half.
  `per-package-output-tree.md` is the output-side twin — deferred, not
  rejected.
