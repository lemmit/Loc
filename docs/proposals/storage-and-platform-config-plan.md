# Implementation Plan: Storage and Platform Config Redesign

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** Phase 12 (Phoenix adapter seams — wrapping Ash as `ash`/`ash-postgres` and adding `ash-commanded` for ES) describes work against a foundation that no longer ships; vanilla Ecto/Phoenix is the sole elixir foundation.

**Companion to:** [`storage-and-platform-config.md`](./storage-and-platform-config.md)
**Audience:** Implementing agent / maintainer.
**Operating principles:**
- **No technical debt.** Each phase ends in a stable, fully-tested state. No "we'll clean this up later" comments left in the tree. Refactors precede new features, not the reverse.
- **All Loom users are internal.** Backward-compat shims in the .ddd grammar are required by the RFC's compatibility matrix, but coordination across internal `.ddd` projects can happen synchronously — a single PR may touch generated-code consumers, fixtures, and examples together. No deprecation cycles.
- **One phase = one PR (or one cohesive sequence).** Each phase is independently mergeable and CI-green. Later phases may depend on earlier ones, but no phase ships in "half-done" state.
- **Tests gate every phase.** New tests are added *as part of* the phase that introduces the feature, not as a follow-up.
- **Existing fixture suite is the regression net.** `test/fixtures/` byte-for-byte comparisons catch unintended generator drift; phases that touch the generator must produce identical output for inputs that didn't use new features.

---

## Reading guide

Each phase lists:

- **Goal** — what this phase delivers, in one sentence.
- **Prerequisites** — phases that must be merged first.
- **Deliverables** — files modified or created, plus key code shapes.
- **Test additions** — what tests are added; which existing tests must still pass.
- **Acceptance gate** — concrete pass/fail criteria for merge.
- **Estimated effort** — calendar days (single engineer, focused).
- **Risks** — what could go wrong; mitigations.

Tasks listed within a phase are sequential unless marked `[parallel]`. Phases without `prerequisites` other than the previous can in some cases run concurrently; this is noted under each phase.

---

## Phase 0 — Branch and tracking

**Goal:** Set up the work branch and per-phase tracking.

**Deliverables:**
- A long-lived integration branch `feat/storage-redesign` off `main`.
- A tracking issue listing all phases with checkboxes; updated as each phase merges.
- A CI matrix sketch (see §11) documenting which env-gated suites must run per phase.

**Acceptance gate:** Branch exists, tracking issue filed.

**Effort:** ~½ day.

---

## Phase 1 — Grammar + IR + lowering + per-feature validation (no behavior change)

**Goal:** Extend `ddd.langium`, the IR types, lowering, and the validator to accept and check all new syntax. Existing `.ddd` files continue parsing and emitting unchanged.

**Prerequisites:** Phase 0.

**Delivery model:** Shipped as **6 small per-feature PRs** rather than one monolithic phase. Each PR is end-to-end at the language layer for one feature (grammar + IR + lowering + per-feature validator + printer + TextMate + tests). See [`storage-and-platform-config-micro-plan.md`](./storage-and-platform-config-micro-plan.md) §F1 for the PR-by-PR breakdown (PR-1 through PR-6). This phase absorbs the original Phase 2 (validator + capability matrix) — per-feature rules live in each PR; the centralized `src/ir/storage-capabilities.ts` infrastructure lands with PR-5.

**Deliverables:**

1. **`src/language/ddd.langium`** — additions:
   - Extend `Storage` rule to accept the logical form (presence of `use:` and `for:`) in addition to physical (`type:`). The rule body becomes a union of allowed keys; XOR validation lives in the validator, not the grammar.
   - New keys on `Storage`: `use`, `for`, `kind`, `schema`, `every`, `retain`, `tablePrefix`, `searchPath`, `isolationLevel`, `keyPrefix`, `ttl`, `topicPrefix`, `retention`, `consumerGroup`, `indexPrefix`, `refreshOnWrite`, `dataset`, `partitionBy`, `readonly`, `migrations`, `instance`, `connection`, `outbox`, `follows`.
   - `LogicalStorageKind` terminal: `state | eventLog | snapshot | cache | replica`.
   - `ConnectionSource` rule: `service(<ident>) | env(<stringLit>) | secret(<ident>) | literal(<stringLit>)`.
   - `OutboxConfig` rule: `auto | disabled | { layout: shared|perAggregate, table:?, publisher: polling|listenNotify|logicalDecoding, interval:? }`.
   - Extend `Aggregate` rule to accept optional `persistenceStrategy: stateBased | eventSourced`.
   - Extend `Event` rule to accept optional `publish: internal | integration | both`.
   - Extend `Deployable` rule to accept platform config block: `platform: <ident> { style:?, layout:?, persistence:?, framework:? }`. Bare `platform: <ident>` continues to parse identically.
   - New `PersistenceConfig` rule (shorthand: ident; block: `{ use, abstraction? }`; `use:` itself can be a single ident or `{ stateBased:, eventSourced: }`).
   - New `OverridesBlock` on `Deployable`: `overrides { (storage <name> { ... })* }`.

2. **`npm run langium:generate`** — regenerate parser/AST.

3. **`src/ir/loom-ir.ts`** — add IR types from RFC §7.3:
   - `PersistenceStrategy`, `EventPublishMode`, `LogicalStorageKind`.
   - `PhysicalStorageIR`, `LogicalStorageIR`, `ConnectionSourceIR`, `OutboxConfigIR`.
   - `PlatformConfigIR`, `PersistenceConfigIR`.
   - Add `persistenceStrategy` field to `AggregateIR` (default `"stateBased"`).
   - Add `publish` field to `EventIR` (default `"internal"`).
   - Add `platformConfig` and `storageOverrides` to `DeployableIR`.

4. **`src/ir/lower.ts` and `src/ir/lower-expr.ts`** — lower the new syntax into the new IR fields. Existing `storage` decls (no `for:`) lower to `PhysicalStorageIR`; presence of `for:` lowers to `LogicalStorageIR`. Defaults applied: missing `kind:` defaults from aggregate's `persistenceStrategy`; missing `persistenceStrategy:` defaults to `stateBased`; missing `publish:` defaults to `internal`; bare `platform:` fills from registry defaults.

5. **`src/language/ddd-scope.ts`** — extend scoping:
   - Resolve `dataSource.use:` against `PhysicalStorage` names.
   - Resolve `dataSource.for:` against module-qualified aggregate names.
   - Resolve `overrides { storage X { ... } }` against existing physical storage names.

**Test additions:**

- `test/parsing/storage-physical.test.ts` — every key combination on the physical form parses.
- `test/parsing/storage-logical.test.ts` — every key combination on the logical form parses.
- `test/parsing/aggregate-strategy.test.ts` — `persistenceStrategy:` parses; default applied.
- `test/parsing/event-publish.test.ts` — `publish:` parses; default applied.
- `test/parsing/platform-config.test.ts` — bare, shorthand-persistence, full-block forms parse.
- `test/parsing/overrides.test.ts` — overrides block parses.
- **Regression:** all existing `test/parsing/*.test.ts` and `test/fixtures/**/*` continue passing.

**Acceptance gate:**
- `npm test` green.
- `npx vitest run test/parsing` covers all new rules.
- `test/fixtures/` byte-for-byte unchanged (since no emitter changes yet).
- New IR fields populated correctly for all new syntax (verified via lowering snapshot tests).

**Effort:** ~5 days across 6 PRs (was: 3d grammar + 2d validator as separate Phase 1 + Phase 2; now merged into this phase as feature-by-feature delivery).

**Risks:**
- Langium grammar gotcha: per `experience_gathered.md` §1, avoid `{infer X.field=current}` actions in alternations. The `Storage` rule uses one form with all keys optional; XOR validation lives in the validator (per PR-5). `ConnectionSource` and `OutboxConfig` alternatives start with a literal keyword each — safe.
- Scoping for `for: Sales.Order` requires `[Aggregate:QualifiedName]` resolution. The existing `Targetable` qualified-name export path already produces `Module.Aggregate` segments; verify on a cross-module test case during PR-5.
- `platformDecl` rename in PR-4 may break consumers of `d.platform`. Grep + migrate; byte-identical fixtures are the regression net.
- `StorageIR` union split in PR-5 forces TS narrowing at every existing consumer. Add `isPhysicalStorage(s)` helper centrally.

---

## Phase 2 — (absorbed into Phase 1)

The original Phase 2 (storage capability matrix + structural validator) is delivered piecewise as part of Phase 1's per-feature PRs:

- `src/ir/storage-capabilities.ts` (the static `STORAGE_CAPABILITIES` infrastructure file) lands with **PR-5**.
- Per-feature validator rules land in their respective PR-N: `follows:` cycle check in PR-3; capability matrix + per-aggregate uniqueness + transactional outbox check + snapshot-only-keys + `kind × persistenceStrategy` in PR-5; override target rules in PR-6.

This entry is retained to keep Phase 3–14 numbering stable for downstream cross-references.

**Effort:** 0 days (absorbed into Phase 1).

The full set of validator rules + error codes that previously belonged to Phase 2 — listed here for the implementer's reference — distribute as follows across Phase 1's PRs:

| Rule | Error code | Lands in |
|---|---|---|
| Physical/logical XOR | `loom.storage-physical-logical-mixed` | PR-5 |
| Per-aggregate uniqueness (one primary, ≤1 of each derived kind) | `loom.duplicate-primary-storage`, `loom.duplicate-derived-storage` | PR-5 |
| `kind` × `persistenceStrategy` consistency | `loom.kind-strategy-mismatch` | PR-5 |
| `(type, kind)` matrix check | `loom.unsupported-kind-for-storage` | PR-5 |
| Outbox-transactional check | `loom.integration-events-need-transactional-store` | PR-5 |
| Snapshot-only keys (`every`, `retain`) | `loom.snapshot-keys-on-non-snapshot` | PR-5 |
| Override target existence + allowed keys | `loom.override-target-not-found`, `loom.override-disallowed-key` | PR-6 |
| `follows:` cycle + type-match | `loom.follows-cycle` | PR-3 |
| `instance:` coalescing config-equality | `loom.instance-conflict` | PR-3 |

---

## Phase 3 — .NET adapter seam refactor (byte-identical output)

**Goal:** Restructure `src/generator/dotnet/` to introduce `PersistenceAdapter`, `StyleAdapter`, and `LayoutAdapter` seams. The existing emitter is wrapped as the default adapters (`efcore` / `cqrs` / `byLayer`). **No output change.**

**Prerequisites:** Phase 1.

**Deliverables:**

1. **New directory structure** under `src/generator/dotnet/`:
   ```
   src/generator/dotnet/
     index.ts                 # platform orchestrator (was: index.ts unchanged shape)
     surface.ts               # PlatformSurface impl (unchanged)
     emit/                    # adapter-agnostic emitters (DTOs, value objects, events, controllers shared across styles)
     styles/
       surface.ts             # StyleAdapter contract
       cqrs/
         handler.ts
         command.ts
         mediator-wire.ts
         di.ts
     persistence/
       surface.ts             # PersistenceAdapter contract
       efcore/
         dbcontext.ts
         repository.ts
         migrations.ts
         di.ts
         capability.ts        # exports the supports(type, kind, strategy) function for this adapter
     layouts/
       surface.ts             # LayoutAdapter contract
       by-layer.ts
     render-expr.ts           # unchanged
     render-stmt.ts           # unchanged
   ```

2. **Move existing emission logic** from current `dotnet/emit/*.ts` and `dotnet/*-builder.ts` into the appropriate subfolder. Files in `emit/` that are ORM-agnostic (DTOs, value objects, events, controllers) stay where they are or move into `emit/`; files that are EF-Core-specific move into `persistence/efcore/`; files that are CQRS-handler-specific move into `styles/cqrs/`.

3. **Adapter contracts** (`PersistenceAdapter`, `StyleAdapter`, `LayoutAdapter`) per RFC §7.2.

4. **`src/generator/dotnet/index.ts`** (platform orchestrator):
   - Resolves the deployable's effective platform config (with defaults).
   - Picks adapters via a registry: `persistence/index.ts`, `styles/index.ts`, `layouts/index.ts`.
   - For each aggregate, picks the right `PersistenceAdapter` based on `persistenceStrategy` and `persistence.use` config.
   - Calls adapters in the right order; stitches their outputs through the `LayoutAdapter` to produce final file paths.

5. **`src/platform/registry.ts`** — extend the .NET entry to declare:
   - `defaultBundle: { stateBased: "efcore", eventSourced: "marten" }` (marten registered but not implemented yet — Phase 7).
   - `styles: { cqrs: ..., layered: ... }` (layered registered but not implemented yet — Phase 4).
   - `layouts: { byLayer: ..., byFeature: ... }` (byFeature not implemented yet — Phase 5).
   - `framework: { minimalApi: ... }` (only one v1 value).

6. **Validator update** — registry-aware validation: rejected `persistence.use:` values must be in the platform's adapter menu, even if the adapter isn't fully implemented yet (Phase 7's `marten` is registered as "known but unimplemented" and errors with a clear "not yet available in this build" message).

**Test additions:**

- `test/generator/dotnet/seam-refactor.test.ts` — byte-identical golden check: every existing `.ddd` example in `test/fixtures/` and `examples/` produces the same emitted output as before the refactor. This is the load-bearing test for this phase.
- `test/generator/dotnet/adapter-contract.test.ts` — each adapter contract is satisfied (every `efcore`/`cqrs`/`by-layer` impl exports the contract surface).

**Acceptance gate:**
- All existing `test/fixtures/dotnet-*` byte-identical.
- `LOOM_TS_BUILD=1` (existing) still passes — generated .NET projects compile.
- `LOOM_DOTNET_BUILD=1` (existing) still passes — `dotnet build /warnaserror` passes.
- No new lint warnings.

**Effort:** 5 days. This is the largest pure-refactor phase. Allocate generous time.

**Risks:**
- File-by-file move may break import chains; mitigate by doing the move in small commits with `tsc -b` running after each.
- Hidden assumptions in current emitter about file paths or layout may surface; mitigate by reading `src/generator/dotnet/` end-to-end before starting.

---

## Phase 4 — .NET layered style adapter

**Goal:** Implement `style: layered` on .NET. A deployable can now opt out of cqrs in favor of controller→service→repository.

**Prerequisites:** Phase 3.

**Deliverables:**

1. **`src/generator/dotnet/styles/layered/`**:
   - `controller.ts` — emits `OrderController` with action methods per aggregate operation.
   - `service.ts` — emits `IOrderService` + `OrderService` (interface + impl).
   - `di.ts` — emits service registration.
   - `capability.ts` — `supportedStrategies: ["stateBased"]`; rejects ES aggregates.

2. **`src/platform/registry.ts`** — `styles.layered` becomes a real implementation.

3. **Validator** — RFC §6.4: `style: layered` × any ES aggregate is an error. RFC §6.4: `style: layered` × `layout: byFeature` is rejected (or coerced to `byLayer` with warning — pick error for v1).

4. **Example `.ddd` files** — add at least one `examples/` file using layered style (a CRUD admin module). Update `examples/acme.ddd` to add an `admin` deployable using layered + stateBased.

**Test additions:**

- `test/generator/dotnet/layered.test.ts` — fixture-based test for the layered emission.
- `test/fixtures/dotnet-layered/` — new fixture set: one example, layered style, golden file tree.
- `test/validation/style-strategy-compat.test.ts` — `layered` × `eventSourced` aggregate produces `loom.style-rejects-strategy` error.

**Acceptance gate:**
- New layered fixtures generate; `LOOM_DOTNET_BUILD=1` confirms the .NET project compiles.
- CQRS fixtures from Phase 3 are byte-identical.
- The layered fixture's generated code passes `dotnet build /warnaserror`.

**Effort:** 4 days.

**Risks:**
- The `service.ts` emitter must consume `render-expr.ts` / `render-stmt.ts` outputs without re-resolving names. Match the existing CQRS handler emitter's pattern.

---

## Phase 5 — .NET `byFeature` layout adapter

**Goal:** Implement `layout: byFeature` on .NET. CQRS-style emission gets organized into feature folders.

**Prerequisites:** Phase 3.

**Deliverables:**

1. **`src/generator/dotnet/layouts/by-feature.ts`** — implements `LayoutAdapter.pathFor()` returning `Features/<OperationName>/<ArtifactKind>.cs` instead of `<ArtifactKind>/<OperationName>.cs`.

2. **No emitter changes** — the artifacts themselves are unchanged; only their paths differ.

3. **Validator** — RFC §6.4: `style: layered` × `layout: byFeature` is an error.

4. **Example `.ddd` files** — add at least one example using byFeature layout (or extend an existing one's deployable).

**Test additions:**

- `test/generator/dotnet/by-feature.test.ts` — same logical content as the byLayer baseline, different paths.
- `test/fixtures/dotnet-by-feature/` — golden file tree.

**Acceptance gate:**
- byFeature fixtures generate with all expected files in the new paths.
- byLayer fixtures byte-identical to current.
- `LOOM_DOTNET_BUILD=1` confirms byFeature .NET projects compile.

**Effort:** 1.5 days. Small phase because no emitter changes.

**Risks:** none meaningful.

---

## Phase 6 — .NET Dapper persistence adapter

**Goal:** Implement `persistence: dapper` on .NET. State-based aggregates can now use Dapper instead of EF Core.

**Prerequisites:** Phase 3.

**Deliverables:**

1. **`src/generator/dotnet/persistence/dapper/`**:
   - `connection.ts` — emits `IDbConnection` registration via Npgsql/MySqlConnector.
   - `repository.ts` — emits Dapper-based repository per aggregate.
   - `migrations.ts` — emits FluentMigrator or DbUp scaffolding (pick one; FluentMigrator integrates more cleanly with .NET project structure).
   - `di.ts` — DI registration.
   - `capability.ts` — `supports(type, kind, strategy)` per RFC §7.2 (state, snapshot, replica on SQL; no eventLog, no cache).

2. **`.csproj` emitter** — extended to add Dapper + Npgsql/MySqlConnector + FluentMigrator NuGet refs when this adapter is selected.

3. **`src/platform/registry.ts`** — `persistence.dapper` becomes real.

4. **Example `.ddd` files** — at least one example using `persistence: dapper`.

**Test additions:**

- `test/generator/dotnet/dapper.test.ts` — fixture-based.
- `test/fixtures/dotnet-dapper/` — golden file tree.
- `LOOM_DOTNET_BUILD=1` matrix: include a Dapper case.

**Acceptance gate:**
- Dapper-emitted .NET project compiles under `LOOM_DOTNET_BUILD=1`.
- Existing EF Core fixtures unchanged.
- Per-aggregate capability validation: an `eventSourced` aggregate in a `persistence: dapper` deployable rejects with a clear error.

**Effort:** 5 days. Dapper repository emission has shape variety per query type.

**Risks:**
- Migration tool choice (FluentMigrator vs DbUp vs raw SQL) — commit to FluentMigrator unless there's a known incompatibility.
- Dapper's lack of an entity tracker means handler patterns are slightly different than EF Core — emitter must produce explicit `SELECT … FOR UPDATE` and explicit `UPDATE` SQL.

---

## Phase 7 — .NET Marten + EF Core eventSourced support

**Goal:** Implement ES support on .NET via two adapters: `marten` (postgres-only, library-backed) and `efcore` (extended to emit a generic events table).

**Prerequisites:** Phases 3, 6.

**Deliverables:**

1. **`src/generator/dotnet/persistence/marten/`**:
   - `session.ts` — `IDocumentSession` / `IEventStore` registration.
   - `repository.ts` — emits `Append`/`LoadStream` per ES aggregate; document-store ops per state aggregate.
   - `di.ts` — DI registration; Marten config block.
   - `capability.ts` — `supports(postgres, state|eventLog|snapshot|replica, stateBased|eventSourced) = true`. Postgres only.

2. **`src/generator/dotnet/persistence/efcore/eventlog.ts`** (extends the efcore adapter):
   - `EventsTableEmitter` — emits the generic `events` table schema (BIGSERIAL id, stream_id + version unique constraint, JSONB payload, occurred_at).
   - `EventStoreEmitter` — emits `EventStore` class with `AppendAsync(streamId, expectedVersion, events)` and `LoadStreamAsync(streamId)`.
   - Update `efcore/capability.ts` to claim `eventLog` support on SQL types.

3. **Snapshot store integration** — when `dataSource X { kind: snapshot, for: ... }` is paired with `kind: eventLog` for the same aggregate, the chosen adapter must emit:
   - The snapshot table (if same store) or the snapshot client (if different store, e.g., redis).
   - The snapshot policy: write a snapshot every `every:` events; `retain:` snapshots kept.
   - Load path: load latest snapshot, then replay events since that snapshot version.

4. **`src/platform/registry.ts`** — `persistence.marten` becomes real; `defaultBundle` for dotnet now resolves `eventSourced` to `marten`.

5. **Aggregate emitter changes** — when `persistenceStrategy: eventSourced`, emit the aggregate with `Apply(event)` methods (one per declared event) instead of property setters. The aggregate's operations enqueue events via `_pendingEvents.Add(...)` instead of mutating state directly.

6. **Validator** — RFC §6.2: ES aggregate × adapter that doesn't support `eventSourced` is an error.

7. **Example `.ddd` files** — extend `examples/acme.ddd` to introduce an ES aggregate (`Sales.Order` becomes ES; `Sales.Quote` stays state-based) with a snapshot dataSource. Existing examples without `persistenceStrategy:` continue to be state-based.

**Test additions:**

- `test/generator/dotnet/marten-es.test.ts` — ES emission via Marten.
- `test/generator/dotnet/efcore-es.test.ts` — ES emission via the generic-events-table efcore path.
- `test/fixtures/dotnet-marten/`, `test/fixtures/dotnet-efcore-es/` — golden trees.
- `test/generator/dotnet/snapshot.test.ts` — snapshot policy emission (in-store and cross-store snapshots).
- `LOOM_DOTNET_BUILD=1` extended: ES case via Marten, ES case via efcore.

**Acceptance gate:**
- Both ES paths compile under `LOOM_DOTNET_BUILD=1`.
- Snapshot policy correctly emitted (every N events writes a snapshot; load replays since snapshot version).
- An ES aggregate in a `persistence: dapper` deployable rejects.
- Validator catches `kind: snapshot` on a state-based aggregate (Phase 2 covers this; verify it still fires).

**Effort:** 10 days. Two adapter implementations plus snapshot integration plus aggregate emitter changes. The largest functional phase.

**Risks:**
- Marten's API surface is wide; pick a minimum subset (`IDocumentSession`, `IEventStore`) and document the choice.
- Generic events table on EF Core is novel emission work; allocate prototyping time.
- Snapshot strategy across stores (events in postgres, snapshots in redis) requires careful coordination — the snapshot writer needs to know the postgres-side version to write atomically with the event append. Mitigation: for v1, restrict cross-store snapshots to "best-effort" semantics (snapshot written after successful append; on failure, skip — next snapshot policy invocation retries).

---

## Phase 8 — Outbox materialization + in-process publisher

**Goal:** When any aggregate publishes integration events, materialize the outbox table in its primary store and emit an in-process publisher that drains it.

**Prerequisites:** Phase 7 (so ES aggregates have a primary store the outbox can attach to).

**Deliverables:**

1. **`src/ir/enrichments.ts`** — new enrichment pass computing the outbox materialization plan:
   - For each physical store, collect all aggregates whose primary store is this physical and that have at least one `event { publish: integration | both }`.
   - If non-empty, materialize one outbox table in this store (default layout: `shared`).
   - Record the per-deployable owner (whichever deployable's `migrationsOwner` owns this physical store).

2. **Per-adapter outbox emitter** — each `PersistenceAdapter` gains an `emitOutbox(physicalStore, aggregates, ctx)` method:
   - `efcore`: emits an `outbox` table migration + a `IOutboxWriter` interface + an EF-Core-backed writer that participates in the current DbContext transaction.
   - `dapper`: emits the outbox table migration + a Dapper-backed writer using the same `IDbTransaction` as the aggregate write.
   - `marten`: emits a Marten document-store-backed outbox using Marten's transactional session.

3. **Publisher process emitter** — emits a `BackgroundService` (in .NET) per physical store with an outbox:
   - Polls the outbox table every N seconds (default 200ms).
   - Reads N unpublished rows (default 100).
   - Publishes to the target (v1: log-only stub; or `IPublisher` interface that the user implements).
   - Marks rows as published.
   - Concurrency-safe via `SELECT … FOR UPDATE SKIP LOCKED` (postgres/mysql) or row-locking equivalent.

4. **Aggregate emitter changes** — when an aggregate emits an event with `publish: integration | both`, the generated `Save` / `AppendEvents` method also inserts an outbox row in the same transaction.

5. **DI registration** — auto-register the outbox writer and publisher in the deployable's DI container.

**Test additions:**

- `test/generator/dotnet/outbox.test.ts` — fixture-based; verifies outbox table + writer + publisher are emitted when integration events exist; verifies they are NOT emitted when no integration events exist.
- `test/integration/outbox-transactional.test.ts` (new `LOOM_OUTBOX_E2E=1` suite) — spins up a postgres docker container, generates a small ES system with integration events, runs the .NET project, confirms:
  - An aggregate save rolls back the outbox row on failure.
  - An aggregate save commits the outbox row on success.
  - The publisher drains the outbox.
- New CI workflow: `outbox-e2e.yml` runs `LOOM_OUTBOX_E2E=1`.

**Acceptance gate:**
- `LOOM_OUTBOX_E2E=1` green.
- Existing fixtures without integration events: no outbox-related code emitted.
- Validator from Phase 2: integration events × non-transactional primary still errors.

**Effort:** 7 days.

**Risks:**
- Publisher's "at-least-once" semantics depend on `SELECT … FOR UPDATE SKIP LOCKED` working correctly across postgres versions and under load. Mitigation: test with concurrent publishers spawned via test harness.
- The "in-process publisher" runs in every API replica; with row-locking it's safe but inefficient. Document the limitation; document the future v2 sidecar option.

---

## Phase 9 — Per-deployable overrides materialization

**Goal:** `deployable apiTest { overrides { storage pg { type: inMemory } } }` correctly produces a per-deployable docker-compose / generated project tree where the override is applied.

**Prerequisites:** Phase 3 (adapter seam exists, so each deployable's emission goes through the right adapter for its effective config).

**Deliverables:**

1. **`src/system/index.ts`** — apply override resolution per deployable:
   - For each deployable, compute the effective physical storage set: `(system-wide physicals) ⊕ (deployable.storageOverrides)`.
   - Use this effective set when picking adapters and emitting connection setup.

2. **`src/system/compose.ts`** (or wherever compose is generated) — per-deployable services. Two deployables overriding the same physical store to different types produce different compose services in their respective compose files.

3. **Migration ownership** — the `migrationsOwner` enrichment must respect the effective per-deployable physical set.

4. **Wire-spec / contract** — when an override changes a physical store's type, the wire shape doesn't change (logical schema is identical), so `.loom/wire-spec.json` is per-system, not per-deployable. No change here.

**Test additions:**

- `test/generator/system/overrides.test.ts` — a system with `api` (postgres) and `apiTest` (inMemory override) generates two distinct deployables with correct compose configs each.
- `test/fixtures/system-overrides/` — golden file tree per deployable.
- `LOOM_E2E=1` extension: add an overrides case to the e2e suite.

**Acceptance gate:**
- Override correctly applied in both adapter selection (e.g., inMemory adapter picked when overridden) and compose service generation.
- Migration generated only by the right deployable.
- `LOOM_E2E=1` green.

**Effort:** 4 days.

**Risks:**
- Migration ownership ambiguity when multiple deployables override the same physical store differently. Mitigation: validator already says one deployable per `migrationsOwner`; the override semantics are "this deployable sees a different store" rather than "this deployable changes the global store" — keep that invariant.

---

## Phase 10 — `platform: node` → `platform: node` rename

**Goal:** Rename the Hono platform to expose runtime/framework separation, preserving backward compatibility.

**Prerequisites:** Phase 3 (so the registry pattern exists). Independent of Phases 4–9.

**Deliverables:**

1. **`src/language/ddd.langium`** — `Platform` rule accepts `node` as a value.

2. **Backward-compat desugar** — `platform: node` (or `platform: node { ... }`) parses, and during lowering is desugared to `platform: node { framework: hono, ... }`. Emit a one-time deprecation warning at validation time.

3. **`src/platform/registry.ts`** — register `node` with `framework: { hono }` (only v1 value); deprecate the `hono` top-level entry.

4. **Internal coordination** — all internal `.ddd` files in `examples/`, `web/src/examples/`, and the org's downstream projects updated to use `platform: node { framework: hono }` in one PR. Per the "all users internal" principle, this can happen synchronously.

5. **Generator directory rename** — `src/generator/hono/` → `src/generator/node/` (or keep `hono/` as the implementation under `node/framework/hono/` if we want to anticipate `fastify` etc.). v1: just rename `hono/` to `node/`; framework variants land later.

**Test additions:**

- `test/parsing/platform-node.test.ts` — both forms parse; old form warns.
- `test/generator/node/rename-equivalence.test.ts` — `platform: node` and `platform: node { framework: hono }` produce byte-identical output.

**Acceptance gate:**
- All existing `hono` fixtures continue producing byte-identical output under the new keyword.
- One-time deprecation warning fires on the old syntax.

**Effort:** 2 days.

**Risks:**
- Internal projects may have committed `.ddd` files with `platform: node`; coordinate the rename PR with the projects-using-Loom team.

---

## Phase 11 — Node platform adapter seams

**Goal:** Apply the Phase 3 refactor pattern to the Node platform: introduce `PersistenceAdapter`/`StyleAdapter`/`LayoutAdapter` seams, wrap existing emitter as defaults.

**Prerequisites:** Phase 10.

**Deliverables:**

1. **Mirror `src/generator/node/` directory structure** to match `src/generator/dotnet/`:
   ```
   src/generator/node/
     index.ts
     surface.ts
     emit/
     styles/
       cqrs/
       layered/
     persistence/
       <currentDefault>/          # the existing default emitter, named for what it actually uses
     layouts/
       by-layer.ts
       by-feature.ts
   ```

2. **Wrap the existing emitter** as the default persistence adapter. (Determine the existing emitter's actual library — Drizzle? Kysely? hand-rolled? — and name the adapter accordingly.)

3. **`src/platform/registry.ts`** — node platform menu populated.

4. **Layered style for node** — implement `styles/layered/` (controller → service → repository).

5. **byFeature layout for node** — same logic as dotnet.

6. **Identify v1 alternate persistence adapter** — based on what's installed today; aim for one alternative (e.g., if current is Drizzle, add Kysely; if current is hand-rolled, add Drizzle).

7. **Identify v1 ES adapter** — TBD per Phase 6 decision; could be a generic-events-table over the existing persistence library (mirrors the efcore-eventLog approach in Phase 7).

**Test additions:**

- `test/generator/node/seam-refactor.test.ts` — byte-identical output for existing fixtures.
- `test/generator/node/layered.test.ts` and `test/generator/node/by-feature.test.ts` — new fixtures.
- `test/fixtures/node-*` matrix extends.

**Acceptance gate:**
- Existing node fixtures byte-identical.
- `npm run test:e2e` (`LOOM_E2E=1`) passes for the node backend.
- `generated-react-build.yml` matrix continues green.

**Effort:** 8 days (refactor + layered + byFeature + alternative persistence + alternate-or-novel ES).

**Risks:**
- The Node emitter's current shape may not separate as cleanly as .NET's. Allocate extra time and consider a lighter refactor if the structure resists the same pattern.

---

## Phase 12 — Phoenix platform adapter seams

**Goal:** Apply the seam pattern to Phoenix; wrap Ash as the default persistence + style adapter; add `ashCommanded` for ES.

**Prerequisites:** Phase 3 pattern stable.

**Deliverables:**

1. **`src/generator/phoenix/`** restructure:
   ```
   src/generator/phoenix/
     index.ts
     surface.ts
     emit/
     styles/
       ash/                  # the current Ash-actions emitter
     persistence/
       ash-postgres/         # current Ash + AshPostgres
       ash-commanded/        # new — Ash + ash_commanded for ES
     layouts/
       by-layer.ts
   ```

2. **`persistence/ash-commanded/`** — implements ES via the `ash_commanded` library (or hand-rolled `commanded` integration if `ash_commanded` is unsuitable; decide based on library maturity at implementation time).

3. **`styles/ash/`** — current Ash actions emitter wrapped as a style adapter.

4. **Phoenix `contexts` style** — per RFC R4, dropped from v1 unless a maintainer commits. The `style:` menu for phoenix has one value (`ash`) in v1.

5. **`src/platform/registry.ts`** — phoenix menu populated.

6. **Example `.ddd` files** — ES aggregate in the Phoenix `examples/` to validate `ashCommanded`.

**Test additions:**

- `test/generator/phoenix/seam-refactor.test.ts` — byte-identical.
- `test/generator/phoenix/ash-commanded.test.ts` — ES via Commanded.
- `LOOM_PHOENIX_BUILD=1` matrix extended.

**Acceptance gate:**
- `LOOM_PHOENIX_BUILD=1` green for both adapters.
- Existing Phoenix fixtures byte-identical.

**Effort:** 7 days.

**Risks:**
- `ash_commanded` library may be immature or incompatible with current Ash version. Mitigation: prototype the smallest possible ES aggregate against it before committing to this phase's scope. If unworkable, hand-roll Commanded integration without Ash — accept that ES on Phoenix is a separate code path from Ash document state.

---

## Phase 13 — Documentation and examples consolidation

**Goal:** Update the user-facing documentation to reflect the new model.

**Prerequisites:** Phases 1–12 merged.

**Deliverables:**

1. **`docs/language.md`** — extend with:
   - The `storage` keyword's two forms (physical, logical).
   - `aggregate { persistenceStrategy: }` and `event { publish: }`.
   - `deployable { platform: <name> { style:, layout:, persistence:, framework: } }`.
   - `overrides { }` block.
   - Per-platform menu reference (style values, layout values, persistence adapter values).

2. **`docs/architecture.md`** — extend the storage section: the layer diagram from RFC §2.2; the invariants from RFC §2.1; the two-layer validation flow.

3. **`docs/generators.md`** — extend the per-platform feature matrix:
   - Persistence adapter column per platform.
   - Style column.
   - Layout column.
   - Outbox support column.
   - ES support column.

4. **`docs/migrations-design.md`** — update for the new logical storage layer: the primary-storage-per-aggregate source of truth.

5. **`examples/`** — update existing examples to use new syntax for clarity (where it helps). Ensure at least one example covers:
   - Casual case (Phase 1 form).
   - Mixed ES + state.
   - Per-deployable overrides.
   - Layered style + byFeature layout.

6. **`web/src/examples/`** — same; the playground gets the same examples.

7. **`experience_gathered.md`** — append the most important gotchas learned during implementation (e.g., "Langium discriminator for storage XOR", "Snapshot cross-store best-effort semantics", "outbox SKIP LOCKED").

**Test additions:**

- `docs/build.mjs` continues to build the playground.
- New example `.ddd` files parse and emit cleanly under all matrix axes.

**Acceptance gate:**
- All linked example files validate and build.
- `pages.yml` (docs site build) green.
- `playground-e2e.yml` green with new examples.

**Effort:** 4 days.

**Risks:** none meaningful; this is a docs phase.

---

## Phase 14 — End-to-end gate + release

**Goal:** Full system passes all gated CI suites; release notes drafted.

**Prerequisites:** All previous phases.

**Deliverables:**

1. **Full CI matrix** runs on the integration branch:
   - `npm test` (fast suite).
   - `LOOM_E2E=1` (e2e + Playwright + OpenAPI parity).
   - `LOOM_TS_BUILD=1`, `LOOM_REACT_BUILD=1`.
   - `LOOM_DOTNET_BUILD=1`.
   - `LOOM_PHOENIX_BUILD=1`.
   - `LOOM_OBS_E2E=1`, `LOOM_OBS_E2E_DOTNET=1`, `LOOM_OBS_E2E_PHOENIX=1`.
   - `LOOM_OUTBOX_E2E=1` (new in Phase 8).
   - `LOOM_BIOME=1`.

2. **Release notes** — markdown summary of the new surface (linkback to RFC), with migration notes for internal projects ("no action required" if they use the old syntax; "recommended migration to new syntax" with examples).

3. **Merge to `main`.**

**Acceptance gate:**
- All env-gated suites green.
- Internal projects coordinated: each downstream `.ddd`-using project has either (a) verified no breakage with current syntax, or (b) updated to new syntax.

**Effort:** 2 days.

**Risks:**
- A late-discovered cross-phase incompatibility forces back-fixes. Mitigation: each phase's acceptance gate is rigorous so this is unlikely.

---

## Cross-cutting concerns

### CI matrix evolution

| Suite | Phase added / extended | Notes |
|---|---|---|
| `npm test` (fast) | Phase 1+ | New parsing + validation + IR + generator unit tests added throughout |
| `LOOM_TS_BUILD=1` | Phase 11 extends | Existing; node fixture set expands |
| `LOOM_DOTNET_BUILD=1` | Phases 4, 5, 6, 7 extend | New cases per .NET phase |
| `LOOM_PHOENIX_BUILD=1` | Phase 12 extends | Ash + Commanded |
| `LOOM_E2E=1` | Phase 9 extends | Overrides E2E case |
| `LOOM_OUTBOX_E2E=1` | **new, Phase 8** | Postgres container + ES system + integration events |
| `LOOM_OBS_E2E*` | Phases 4–8 may extend | Confirm observability envelope still correct |
| `LOOM_BIOME=1` | Phase 11 may extend | Node fixture set expands |

### Fixture management strategy

- Each phase that touches generation **must update or add fixtures** in the same PR. No phase ends with stale fixtures.
- `scripts/capture-baseline-fixture.mjs` is the canonical capture tool (per CLAUDE.md). Use it; do not hand-edit fixture trees.
- Per-aggregate, per-strategy, per-style, per-layout, per-adapter fixture combinations explode. Cap the matrix:
  - One fixture per **distinct emit shape**, not per combination.
  - Use `web/src/examples/` for the broader matrix exercised by `generated-react-build.yml`.
  - Avoid duplicating fixtures that differ only in irrelevant fields.

### IR enrichment ordering

The enrichment passes (`src/ir/enrichments.ts`) gain new responsibilities in this work. Order of application matters:

1. (existing) `wireShape` per aggregate / part / value object.
2. (existing) Auto-`findAll` on repositories.
3. (existing) React `targets:` inheritance.
4. **(new, Phase 9)** Per-deployable physical storage resolution (apply overrides).
5. **(new, Phase 2)** Per-aggregate logical storage resolution (find primary, derived).
6. **(new, Phase 7)** Adapter selection per (aggregate, deployable).
7. **(new, Phase 8)** Outbox materialization plan.

Each pass is pure; passes do not mutate previous pass outputs.

### Backward compatibility audit

Per RFC §8, every old form continues to work. Sanity-check at the start of Phase 13:

- `storage primarySql { type: postgres }` — parses, lowers as physical.
- `modules: Sales { primary: pg, cache: redis }` — desugars to anonymous logical storages.
- `aggregate Order { ... }` (no `persistenceStrategy`) — defaults to `stateBased`.
- `event Placed { ... }` (no `publish`) — defaults to `internal`.
- `platform: dotnet` (bare) — defaults applied from registry.
- `platform: node` — desugars to `platform: node { framework: hono }`.

Each of these has a regression test in `test/parsing/` and a byte-identical fixture in `test/fixtures/`.

### Adapter implementation order rationale

The phases above implement adapters in this order:

1. .NET seam (Phase 3) — first because the existing .NET emitter has the clearest pre-existing structure.
2. .NET layered + byFeature (Phases 4, 5) — light additions that validate the seam.
3. .NET Dapper (Phase 6) — validates the persistence-adapter contract with a meaningfully different impl.
4. .NET Marten + EF Core ES (Phase 7) — the most architecturally significant change.
5. Outbox (Phase 8) — depends on ES landing first.
6. Overrides (Phase 9) — depends on adapter selection working end-to-end.
7. Node (Phases 10, 11) — same arc applied second; benefits from .NET lessons.
8. Phoenix (Phase 12) — same arc applied third; benefits from earlier lessons.

Reordering is possible (e.g., do Node refactor in parallel with .NET adapters) but increases risk of inconsistent seam shapes across platforms. The chosen order trades total wall-clock time for consistency.

### Effort summary

| Phase | Effort | Delivery |
|---|---|---|
| 0 — Tracking | 0.5d | — |
| 1 — Grammar + IR + lowering + per-feature validation | 5d | 6 small PRs (PR-1 through PR-6); see micro-plan §F1 |
| 2 — (absorbed into Phase 1) | 0d | — |
| 3 — .NET seam refactor | 5d | 1 PR |
| 4 — .NET layered style | 4d | 1 PR |
| 5 — .NET byFeature layout | 1.5d | 1 PR |
| 6 — .NET Dapper | 5d | 1 PR |
| 7 — .NET Marten + EF ES | 10d | 1–2 PRs |
| 8 — Outbox | 7d | 1 PR |
| 9 — Overrides | 4d | 1 PR |
| 10 — Platform rename | 2d | 1 PR |
| 11 — Node seams | 8d | 1–2 PRs |
| 12 — Phoenix seams | 7d | 1–2 PRs |
| 13 — Docs | 4d | 1 PR |
| 14 — Release gate | 2d | tag + release notes |
| **Total** | **~65 days** | **~17–19 PRs** |

This is a calendar-weeks effort for a focused implementer, not a sprint. Realistic timeline including review cycles and integration friction: **3–4 months**.

### Parallelization

Phases that can run concurrently (across multiple implementers):

- Phase 3 (dotnet seam) || Phase 10 (platform rename — non-overlapping files).
- Phase 4 (layered) || Phase 5 (byFeature) || Phase 6 (Dapper) — once Phase 3 is merged.
- Phase 11 (node seams) || Phase 12 (phoenix seams) — once Phase 3's pattern is stable.

Sequential bottlenecks: 1 → 2 → 3 → 7 → 8 → 9.

### Risk register (cross-phase)

| Risk | Phase | Severity | Mitigation |
|---|---|---|---|
| Langium grammar ambiguity for storage physical/logical | 1 | medium | Use discriminator pattern from `experience_gathered.md` |
| Seam refactor breaks hidden assumptions in existing emitter | 3, 11, 12 | medium | Byte-identical fixture gate; read end-to-end before refactoring |
| Marten dependency surface too wide | 7 | medium | Pin to `IDocumentSession` + `IEventStore`; document |
| Generic events table emission on EF Core / Drizzle / Ecto is novel | 7, 11, 12 | medium | Prototype the smallest ES aggregate before committing each phase |
| Outbox publisher under load / multiple replicas | 8 | low | `FOR UPDATE SKIP LOCKED`; document v2 sidecar option |
| Snapshot cross-store best-effort semantics surprise users | 7 | low | Document in `docs/generators.md`; warn in validator if user wires it cross-store |
| `ash_commanded` immaturity | 12 | medium | Prototype Phase 12 before committing scope; have hand-rolled Commanded fallback |
| Internal `.ddd` projects use `platform: node` heavily | 10 | low | Synchronous rename PR; deprecation warning gives grace period |

---

## Appendix A — File-by-file inventory of new code

Tracking the new files this proposal creates (not exhaustive, but the load-bearing ones):

```
src/ir/storage-capabilities.ts                          # Phase 2

src/generator/dotnet/persistence/surface.ts             # Phase 3
src/generator/dotnet/persistence/efcore/*.ts            # Phase 3 (move from existing)
src/generator/dotnet/persistence/efcore/eventlog.ts     # Phase 7
src/generator/dotnet/persistence/dapper/*.ts            # Phase 6
src/generator/dotnet/persistence/marten/*.ts            # Phase 7

src/generator/dotnet/styles/surface.ts                  # Phase 3
src/generator/dotnet/styles/cqrs/*.ts                   # Phase 3 (move from existing)
src/generator/dotnet/styles/layered/*.ts                # Phase 4

src/generator/dotnet/layouts/surface.ts                 # Phase 3
src/generator/dotnet/layouts/by-layer.ts                # Phase 3 (extract)
src/generator/dotnet/layouts/by-feature.ts              # Phase 5

src/generator/node/...                                  # Phase 11 mirror of dotnet/
src/generator/phoenix/...                               # Phase 12 mirror of dotnet/

test/parsing/storage-physical.test.ts                   # Phase 1
test/parsing/storage-logical.test.ts                    # Phase 1
test/parsing/aggregate-strategy.test.ts                 # Phase 1
test/parsing/event-publish.test.ts                      # Phase 1
test/parsing/platform-config.test.ts                    # Phase 1
test/parsing/overrides.test.ts                          # Phase 1
test/parsing/platform-node.test.ts                      # Phase 10

test/validation/storage-physical-logical.test.ts        # Phase 2
test/validation/storage-capabilities.test.ts            # Phase 2
test/validation/overrides.test.ts                       # Phase 2
test/validation/follows.test.ts                         # Phase 2
test/validation/style-strategy-compat.test.ts           # Phase 4

test/generator/dotnet/seam-refactor.test.ts             # Phase 3
test/generator/dotnet/layered.test.ts                   # Phase 4
test/generator/dotnet/by-feature.test.ts                # Phase 5
test/generator/dotnet/dapper.test.ts                    # Phase 6
test/generator/dotnet/marten-es.test.ts                 # Phase 7
test/generator/dotnet/efcore-es.test.ts                 # Phase 7
test/generator/dotnet/snapshot.test.ts                  # Phase 7
test/generator/dotnet/outbox.test.ts                    # Phase 8
test/generator/system/overrides.test.ts                 # Phase 9
test/generator/node/...                                 # Phase 11
test/generator/phoenix/...                              # Phase 12

test/integration/outbox-transactional.test.ts           # Phase 8 (LOOM_OUTBOX_E2E)

test/fixtures/dotnet-layered/                           # Phase 4
test/fixtures/dotnet-by-feature/                        # Phase 5
test/fixtures/dotnet-dapper/                            # Phase 6
test/fixtures/dotnet-marten/                            # Phase 7
test/fixtures/dotnet-efcore-es/                         # Phase 7
test/fixtures/system-overrides/                         # Phase 9
```

## Appendix B — Glossary cross-reference

For the implementing agent, the canonical definitions of each term live in the RFC:

| Term | RFC section |
|---|---|
| Physical storage | §3.1 |
| Logical storage | §3.2 |
| `LogicalStorageKind` (state, eventLog, snapshot, cache, replica) | §3.2 |
| `persistenceStrategy` (stateBased, eventSourced) | §3.4 |
| `publish` (internal, integration, both) | §3.5 |
| `style` (cqrs, layered; per platform menu) | §3.6, §4 |
| `layout` (byLayer, byFeature) | §3.6, §4 |
| `persistence.use` adapter | §3.7, §4 |
| `overrides` block | §3.8 |
| Storage capability matrix | §6.6 |
| Adapter contracts | §7.2 |

When in doubt, the RFC is authoritative. This plan describes execution order and acceptance gates; it does not redefine semantics.
