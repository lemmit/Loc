# Foundation Plan: Storage + Platform Config Skeleton

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** The Phoenix F7 adapter-seam work below (wrapping the Ash emitter as `ashPostgres`/`ash` and stubbing `ashCommanded`/`contexts`), and the `style: ash` menu value, describe options that no longer exist — vanilla Ecto/Phoenix is the sole elixir foundation.

**Companion to:** [`storage-and-platform-config.md`](./storage-and-platform-config.md) (the RFC) and [`storage-and-platform-config-plan.md`](./storage-and-platform-config-plan.md) (the full implementation plan).
**Audience:** Implementing agent. After this lands, multiple agents can pick up parallel work streams.

---

## Goal

Ship the **structural foundation** of the storage + platform-config redesign in one cohesive sequence:

- All new grammar parses.
- All new IR fields are populated by lowering.
- All validation rules from RFC §6 fire correctly.
- Adapter seams (`PersistenceAdapter`, `StyleAdapter`, `LayoutAdapter`) are defined.
- The existing emitters are wrapped as the **default adapters** with byte-identical output.
- All non-default adapters / styles / layouts are **registered as stubs** that produce a clear "not yet implemented" error at emit time.
- Outbox emission and per-deployable overrides are **stubbed** in the same way.

After this lands, the grammar, IR, validator, and adapter contracts are **locked**. The remaining 11 work streams (one per stub) become independent: each is "fill in one adapter's emit methods; the rest of the system is already wired".

## Why this exists

The full implementation plan is ~65 implementer-days serialized. Most of the dependency chain is in the early phases (grammar → validator → seam refactor), with the actual feature implementations (Dapper, Marten, layered style, byFeature layout, outbox, overrides, etc.) sitting on top of the same seams. By landing the foundation first and stubbing the rest, the follow-up work parallelizes across multiple agents.

**Estimated foundation effort:** ~22 days serialized; ~12 days wall-clock with 4 concurrent agents after F3 (vs. ~65 for the full plan).
**Parallel follow-up effort:** ~68 days summed across 15 streams, compressing to ~14–27 calendar days with 3–5 concurrent agents.

## In scope (this micro plan)

- **From full plan Phase 1**: Grammar additions — complete.
- **From full plan Phase 2**: Validator + capability matrix — complete.
- **Downstream consumer alignment**: VS Code TextMate grammar, playground editor (Monaco) tokens, visual builders (`web/src/builder/system{,-v2}/` audit and round-trip preservation), playground examples, Playwright suite. **Round-trip preservation is the bar; full builder UI for new constructs is deferred to stream N.**
- **From full plan Phase 3**: .NET adapter seam refactor — complete.
- **From full plan Phase 10**: `platform: node` → `platform: node { framework: hono }` rename — complete.
- **From full plan Phase 11**: Node adapter seam refactor — complete (seams only, no new adapters).
- **From full plan Phase 12**: Phoenix adapter seam refactor — complete (seams only, no `ashCommanded`).
- **Stub registrations** for: `persistence.dapper`, `persistence.marten`, `persistence.ashCommanded`, `style.layered`, `style.contexts`, `layout.byFeature`, EF Core eventSourced, Node ES adapter, outbox emission, per-deployable overrides.

## Out of scope (deferred to parallel follow-up streams)

- Actual emitter implementations of any stubbed adapter / style / layout.
- Actual outbox table + publisher emission.
- Actual override resolution and per-deployable compose generation.
- New documentation beyond updating the RFC's `Status:` line and a "What's stubbed" section in this doc.

---

## Foundation phases

### F1 — Grammar + IR + lowering + per-feature validation (delivered as 6 small PRs)

**Goal:** All new syntax parses, lowers, populates IR fields, AND is validated. No behavior change in emitters. **Delivered feature-by-feature** as a sequence of small PRs so each can be reviewed, accepted, deferred, or vetoed independently.

**Delivery model:** Each of the six PRs below is end-to-end at the language layer for one feature (grammar + IR + lowering + per-feature validator + printer + TextMate + tests). No PR introduces emitter changes. `test/fixtures/**` stays byte-identical throughout the sequence.

#### PR-1 — `aggregate { persistenceStrategy: stateBased | eventSourced }` (~0.5d)

- **Grammar**: extend `Aggregate` rule with optional `('persistenceStrategy' ':' persistenceStrategy=PersistenceStrategy ','?)?` between `withClause` and the members block. Add `PersistenceStrategy returns string: 'stateBased' | 'eventSourced'`.
- **IR**: add `PersistenceStrategy` type; extend `AggregateIR.persistenceStrategy?: PersistenceStrategy` (defaulted to `"stateBased"` in lowering).
- **Lowering**: `lowerAggregate` reads `agg.persistenceStrategy ?? "stateBased"`.
- **Validator**: none yet (capability checks come with PR-5).
- **Printer** (`src/language/print/print-structural.ts`): emit the key when present so `print-roundtrip.test.ts` stays green.
- **TextMate**: add `persistenceStrategy`, `stateBased`, `eventSourced` keywords.
- **Tests**: parsing positive/negative, IR default-applied, printer round-trip.

#### PR-2 — `event { publish: internal | integration | both }` (~0.5d)

Same shape as PR-1, on `EventDecl`:
- Extend rule with `('publish' ':' publish=EventPublishMode ','?)?` before fields list. Add `EventPublishMode returns string: 'internal' | 'integration' | 'both'`.
- `EventIR.publish?: EventPublishMode`, defaulted to `"internal"`.
- Printer + TextMate updates (`publish`, `internal`, `integration`, `both`).
- No validator rules yet (outbox-transactional check comes with PR-5).

#### PR-3 — `storage` extended physical form (~1d)

Adds physical-side keys to the existing `Storage` rule without introducing the logical form yet:
- **Grammar**: extend `Storage` rule with optional `instance:`, `connection:`, `outbox:`, `follows:` keys. Add `ConnectionSource` rule with `{infer …}` alternatives (each starting with a keyword `service` / `env` / `secret` / `literal` — avoiding the `experience_gathered.md` §1 trap). Add `OutboxConfig` rule with alternatives `auto | disabled | { layout:?, table:?, publisher:?, interval:? }`.
- **IR**: extend `StorageIR` (still a single interface — no union split yet) with optional `instance`, `connection`, `outbox`, `follows` fields. Add `ConnectionSourceIR` and `OutboxConfigIR` discriminated unions.
- **Lowering**: extend storage lowering at `lower.ts:505-512` with helpers `lowerConnection`, `lowerOutbox` (place in `lower-expr.ts` or a new `lower-storage.ts`).
- **Scope** (`src/language/ddd-scope.ts`): `Storage.follows` resolves to `[Storage:LooseName]`.
- **Validator**: `follows:` cycle check; `follows:` target must share the same `type:`.
- **Printer** + **TextMate** updates for new keys and value literals (`service`, `env`, `secret`, `literal`, `auto`, `disabled`, `shared`, `perAggregate`, `polling`, `listenNotify`, `logicalDecoding`).
- **Tests**: positive parse per new key, lowering produces expected IR, cycle check fires.

#### PR-4 — `deployable { platform: <name> { style:, layout:, persistence:, framework: } }` (~1d)

Replaces the current `platform: <Platform>` clause with `platform: PlatformDecl` while keeping the bare form (`platform: dotnet`) byte-identical-in-IR.

- **Grammar**: introduce `PlatformDecl: name=Platform ('{' config=PlatformConfig '}')?`. Add `PlatformConfig` with optional `style`, `layout`, `persistence`, `framework` keys. Add `PersistenceConfig` with the shorthand-vs-block disambiguation `(useSingle=ID | '{' useByStrategy=PersistenceByStrategy '}')`. Add `LayoutName: 'byLayer' | 'byFeature'` and `PersistenceAbstraction: 'repositoryPerAggregate' | 'none'`.
- **IR**: `PlatformConfigIR` and `PersistenceConfigIR` per RFC §7.3. Add `DeployableIR.platformConfig?: PlatformConfigIR`.
- **Lowering** (`lowerDeployable` around line 740): read `d.platformDecl.name` (was `d.platform`) for the existing `platform` field; build `platformConfig` only when any sub-key is set. Bare-form yields `platformConfig: undefined` — defaults are NOT baked into the IR here (they belong to the platform registry).
- **Audit step**: grep every existing consumer of `d.platform` and migrate to `d.platformDecl.name`; byte-identical fixtures are the regression net.
- **Printer** + **TextMate** updates (`style`, `layout`, `persistence`, `framework`, `byLayer`, `byFeature`, `repositoryPerAggregate`, `none`).
- **Tests**: bare form parses with `platformConfig: undefined`; block form populates IR; persistence shorthand vs block vs per-strategy.

#### PR-5 — `storage` logical form + capability matrix (~1.5d)

The largest of the six. Introduces the discriminated-union split on `StorageIR` and the static `STORAGE_CAPABILITIES` matrix.

- **Grammar**: extend the `Storage` rule with the logical keys (`use`, `for`, `kind`, plus `schema`, `every`, `retain`, `tablePrefix`, `searchPath`, `isolationLevel`, `keyPrefix`, `ttl`, `topicPrefix`, `retention`, `consumerGroup`, `indexPrefix`, `refreshOnWrite`, `dataset`, `partitionBy`, `readonly`, `migrations`). `for` is `[Aggregate:QualifiedName]`. Add `LogicalStorageKind`, `RefreshOnWrite`, `MigrationsMode`, `BoolLit`, `IsolationLevel`.
- **IR**: split `StorageIR` into a discriminated union `PhysicalStorageIR | LogicalStorageIR` with a `kind: "physical" | "logical"` tag. Migrate every existing consumer to use an `isPhysicalStorage(s)` narrowing helper. Legacy `storage X { type: pg }` decls all lower to the physical variant → byte-identical emitter output.
- **New file**: `src/ir/storage-capabilities.ts` per RFC §6.6 — static `STORAGE_CAPABILITIES` matrix, `TRANSACTIONAL_TYPES`, `supportsKind`, `isTransactional`.
- **Lowering**: branch on `for:` presence. Logical-kind default: infer from the resolved aggregate's `persistenceStrategy` (`stateBased` → `"state"`, `eventSourced` → `"eventLog"`). Requires lowering aggregates BEFORE storages so the strategy map is available.
- **Scope**: `Storage.use` filters to physical only; `Storage.for` resolves to `[Aggregate:QualifiedName]` (exported via existing `Targetable` qualified-name path).
- **Validator** (the meaty piece — RFC §6.1 + §6.6):
  - Physical/logical XOR (`loom.storage-physical-logical-mixed`).
  - `(type, kind)` compatibility from `STORAGE_CAPABILITIES` (`loom.unsupported-kind-for-storage`).
  - Snapshot-only keys on non-snapshot decls (`loom.snapshot-keys-on-non-snapshot`).
  - `kind` × `persistenceStrategy` consistency (`loom.kind-strategy-mismatch`).
  - At most one primary (`state` or `eventLog`) per aggregate; at most one per derived kind.
  - Aggregates with `publish: integration | both` events require their primary store to be transactional (`loom.integration-events-need-transactional-store`).
- **Printer** + **TextMate** updates (`use`, `for`, `kind`, `state`, `eventLog`, `snapshot`, `cache`, `replica`, plus type-specific keys).
- **Tests**: every cell of the matrix (positive + negative); per-key parsing and lowering; printer round-trip per kind.

#### PR-6 — `deployable { overrides { storage X { ... } } }` (~0.5d)

- **Grammar**: add `overrides+=StorageOverride*` to `Deployable`. `StorageOverride: 'storage' target=[Storage:LooseName] '{' (optional physical keys) '}'`. Distinct rule from `Storage` — no ambiguity.
- **IR**: `StorageOverrideIR`; `DeployableIR.storageOverrides?: StorageOverrideIR[]`.
- **Lowering** in `lowerDeployable`.
- **Validator**: override target must exist + be physical (`loom.override-target-not-found`); only `type`, `connection`, `instance`, `outbox` keys allowed (`loom.override-disallowed-key`).
- **Printer** + **TextMate** updates (`overrides` keyword).
- **Tests**: parsing, lowering, validator rejections.

#### Ordering and dependencies

```
PR-1 (persistenceStrategy)  ┐
PR-2 (event publish)        ┼── independent; can land in any order
PR-3 (storage physical+)    ┘
PR-4 (deployable platform config) — independent of 1-3

PR-5 (storage logical + matrix) — depends on PR-1 (kind default from strategy) and PR-3 (use: target physical storage)
PR-6 (overrides)             — depends on PR-3 (override target physical)
```

Suggested merge order: PR-1 → PR-2 → PR-3 → PR-4 → PR-5 → PR-6.

#### Per-PR shared checklist

- `npm run langium:generate` and `npm test` green
- `test/fixtures/**` byte-identical (the regression net)
- `LOOM_TS_BUILD=1` and `LOOM_BIOME=1` green
- `test/language/print-roundtrip.test.ts` and `print-structural-roundtrip.test.ts` green
- `test/language/textmate-grammar.test.ts` green (new keywords added)
- At least one positive parsing test per new grammar production
- At least one IR lowering snapshot test per new field
- At least one validator test per new error code (PR-3, PR-5, PR-6)

#### Acceptance gate for F1 as a whole

All six PRs merged; `npm test` green; one hand-written fixture exercises all features at once; `examples/showcase.ddd` and every existing `.ddd` example parses, validates, and emits byte-identical output to the pre-F1 baseline.

**Effort:** ~5 days serialized (sum of the six). Parallelizable across two agents (PR-1 through PR-4 are independent of each other; PR-5 and PR-6 follow).

**Why six PRs, not one:** Each feature is genuinely independent at the grammar/IR/lowering level. Feature-by-feature delivery lets each PR be reviewed, accepted, deferred, or vetoed individually. Combining them increases review friction and entangles concerns.

---

### F2 — (absorbed into F1)

The original F2 scope (validator + storage capability matrix) is delivered piecewise as part of F1's per-feature PRs:

- **`src/ir/storage-capabilities.ts`** (the static `STORAGE_CAPABILITIES` infrastructure file) lands with **PR-5**.
- **Per-feature validator rules** land in their respective PR-N (cycle check in PR-3; capability + uniqueness + transactional outbox + snapshot-only-keys in PR-5; override target rules in PR-6).
- **Per-aggregate uniqueness** for primary/derived storage kinds lands in PR-5 alongside the matrix.

This entry is retained only to keep F3–F8 numbering stable for downstream cross-references. The effort budget moves into F1.

**Effort:** 0 days (absorbed).

---

### F3 — Adapter contract definitions

**Goal:** Define the three adapter contracts (`PersistenceAdapter`, `StyleAdapter`, `LayoutAdapter`) and a registry that resolves them per platform.

**Prerequisites:** F1, F2 (so the IR has fields the contracts can read).

**Deliverables:**

1. **`src/generator/_adapters/persistence-surface.ts`** (new — shared across platforms):
   ```typescript
   export interface PersistenceAdapter {
     name: string;
     supportedStrategies: PersistenceStrategy[];
     supports(type: StorageType, kind: LogicalStorageKind, persistenceStrategy: PersistenceStrategy): boolean;
     emitProjectDeps(ctx: EmitCtx): Lines;
     emitConnectionSetup(physicalStores: PhysicalStorageIR[], ctx: EmitCtx): Lines;
     emitRepository(agg: AggregateIR, logical: LogicalStorageIR, ctx: EmitCtx): Lines;
     emitMigrations(aggs: AggregateIR[], physicalStores: PhysicalStorageIR[], ctx: EmitCtx): Lines | null;
     emitOutbox(physical: PhysicalStorageIR, aggs: AggregateIR[], ctx: EmitCtx): Lines | null;
   }
   ```

2. **`src/generator/_adapters/style-surface.ts`** (new):
   ```typescript
   export interface StyleAdapter {
     name: string;
     supportedStrategies: PersistenceStrategy[];
     supportedLayouts: ("byLayer" | "byFeature")[];
     emitEndpoint(op: AggregateOpIR, ctx: EmitCtx): Lines;
     emitHandlerOrService(op: AggregateOpIR, ctx: EmitCtx): EmittedArtifact[];
     emitDi(ctx: EmitCtx): Lines;
   }
   ```

3. **`src/generator/_adapters/layout-surface.ts`** (new):
   ```typescript
   export interface LayoutAdapter {
     name: string;
     pathFor(artifact: EmittedArtifact, ctx: EmitCtx): string;
   }
   ```

4. **`src/generator/_adapters/not-implemented.ts`** — the canonical stub error helper:
   ```typescript
   export class AdapterNotImplementedError extends Error {
     constructor(
       readonly adapterKind: "persistence" | "style" | "layout",
       readonly adapterName: string,
       readonly platformName: string,
       readonly availableImplementations: string[]  // sibling adapters of the same kind that ARE implemented
     ) {
       const available = availableImplementations.length
         ? `Available implementations: ${availableImplementations.join(", ")}.`
         : `No implementations of this ${adapterKind} are available yet.`;
       super(
         `${adapterKind} adapter '${adapterName}' is not yet implemented for platform '${platformName}'. ` +
         available
       );
       this.name = "AdapterNotImplementedError";
     }
   }

   export function stubAdapter<T extends object>(
     adapterKind: "persistence" | "style" | "layout",
     adapterName: string,
     platformName: string,
     getAvailableImplementations: () => string[],  // called lazily so registry is fully constructed
     capabilityDeclaration: Partial<T>  // e.g., for persistence: { name, supportedStrategies, supports }
   ): T {
     const throwing: any = new Proxy({}, {
       get(target, prop) {
         if (prop in capabilityDeclaration) return (capabilityDeclaration as any)[prop];
         // Methods that are emit* throw at call time
         if (typeof prop === "string" && prop.startsWith("emit")) {
           return () => {
             throw new AdapterNotImplementedError(
               adapterKind, adapterName, platformName, getAvailableImplementations()
             );
           };
         }
         return undefined;
       }
     });
     return throwing as T;
   }
   ```

   The internal tracking (which plan phase a stub corresponds to) lives in **code comments next to the stub registration**, not in user-facing messages.

5. **`src/platform/registry.ts`** — extend the platform record to carry adapter menus:
   ```typescript
   export interface PlatformEntry {
     name: string;
     surface: PlatformSurface;
     defaultBundle: { stateBased: string; eventSourced: string };
     defaultStyle: string;
     defaultLayout: "byLayer";
     defaultFramework?: string;
     persistence: Record<string, PersistenceAdapter>;
     styles: Record<string, StyleAdapter>;
     layouts: Record<string, LayoutAdapter>;
     frameworks: Record<string, FrameworkAdapter>;  // if needed
   }
   ```

**Tests:**
- `test/adapters/contract-shape.test.ts` — type-level: each adapter has the right method signatures.
- `test/adapters/stub-throws.test.ts` — calling an emit method on a stub throws `AdapterNotImplementedError` with the right tracking-phase string.
- `test/adapters/registry-lookup.test.ts` — bare `platform: dotnet` resolves to the right defaults; explicit `persistence: dapper` resolves to the registered (stub) Dapper adapter.

**Acceptance:** Contracts compile; registry resolves; stub helper throws with the documented error message.

**Effort:** 2 days.

---

### F4 — Downstream consumer alignment (playground, VS Code, builders)

**Goal:** Every consumer of the grammar/IR/AST sitting outside `src/` is updated to handle the new surface. Syntax highlighting, the visual builders, the playground editor, examples, and the VS Code extension all work with the new keywords. Stubbed-feature errors surface gracefully in the playground UI.

**Prerequisites:** F1 (grammar locked), F2 (validator behavior locked). Independent of F5/F6/F7/F8 — can run in parallel with the platform seam refactors.

**Deliverables:**

1. **`vscode/grammars/ddd.tmLanguage.json`** — add every new keyword and value-literal so syntax highlighting renders correctly:
   - Storage logical-form keys: `use`, `for`, `kind`, `every`, `retain`, `tablePrefix`, `searchPath`, `isolationLevel`, `keyPrefix`, `ttl`, `topicPrefix`, `retention`, `consumerGroup`, `indexPrefix`, `refreshOnWrite`, `dataset`, `partitionBy`, `readonly`, `migrations`.
   - Storage physical-only keys: `instance`, `connection`, `outbox`, `follows`.
   - `LogicalStorageKind` values: `state`, `eventLog`, `snapshot`, `cache`, `replica`.
   - Aggregate: `persistenceStrategy`, `stateBased`, `eventSourced`.
   - Event: `publish`, `internal`, `integration`, `both`.
   - Platform config keys: `style`, `layout`, `persistence`, `framework`.
   - Layout values: `byLayer`, `byFeature`.
   - Style values: `cqrs`, `layered`, `ash`, `contexts`.
   - Block: `overrides`.
   - Connection sources: `service`, `env`, `secret`, `literal`.
   - Outbox config: `auto`, `disabled`, `shared`, `perAggregate`, `polling`, `listenNotify`, `logicalDecoding`.

2. **`vscode/language-configuration.json`** — review for bracket/comment changes (likely no-op, but verify against the new grammar).

3. **`web/src/editor/`** — Monaco language definition. If it carries its own keyword/token list separate from the Langium-driven LSP highlighting, mirror the TextMate additions here. If Monaco highlighting derives entirely from Langium tokens, no changes needed beyond rebuilding.

4. **Visual builders under `web/src/builder/`** — audit each sub-builder for AST assumptions:

   | Sub-builder | What to check | Action |
   |---|---|---|
   | `page/` | Page body editing — does not touch storage/aggregate/deployable surfaces | None expected; verify by parsing a `.ddd` with new syntax and confirming the page builder still operates correctly |
   | `system/` | System-level visual editing of modules, aggregates, deployables, storages | Audit AST nodes touched; ensure round-trip preserves new fields (`persistenceStrategy`, `publish`, `platformConfig`, `storageOverrides`, logical-storage variant of `Storage`); apply the "Opaque" pattern from the page builder where the UI doesn't yet model a construct |
   | `system-v2/` | Same as above, newer rewrite | Same audit |
   | `requirements/` | Requirements/traceability — orthogonal to storage redesign | None expected; verify |

   For sections the builder UI doesn't model:
   - **Round-trip preservation** is the bar. Builder must not silently drop new fields when writing `.ddd` back. Use the existing "opaque node" / verbatim-source pattern (per `docs/builder-roadmap.md`).
   - **Read-only fallback** is acceptable. If the system builder displays an aggregate, it may show `persistenceStrategy: eventSourced` as read-only text rather than as an editable selector. Editing-via-the-builder for new constructs lands in a follow-up stream.

5. **`web/src/examples/`** — audit existing examples; all must continue parsing and validating. Add at most one or two **new examples** demonstrating:
   - A `dataSource X { for: Y, kind: state }` logical-storage form (parses + validates, generates fine since this is a real adapter path).
   - One example that uses a stubbed feature deliberately to show the user-facing error message — useful for documenting the stub experience. Mark it as such.

6. **Playwright suite (`web/e2e/`)** — add tests:
   - Parse a `.ddd` file containing every new keyword. Verify no parse errors.
   - Trigger validation errors deliberately (e.g., `kind: eventLog` on a `stateBased` aggregate). Verify the error renders in the Problems panel with the correct message.
   - Trigger a stubbed-feature emission (e.g., `persistence: dapper`). Verify the playground's generate-and-preview step shows `AdapterNotImplementedError` with the user-facing message ("not yet implemented for platform 'dotnet'. Available implementations: efcore.").

7. **VS Code extension smoke test** (manual checklist; document in `vscode/CHANGELOG.md`):
   - Open a `.ddd` file with new syntax in VS Code with the extension active.
   - Confirm syntax highlighting matches expectation for every new keyword.
   - Confirm hover and completion still work (Langium-driven, should be automatic).
   - Confirm validation errors surface in the Problems panel.

8. **`docs/builder-roadmap.md`** — append a section noting which new constructs the builders explicitly do NOT yet model (so future builder work has a known starting point). Do not block on full builder support.

**Tests:**
- TextMate grammar lint / smoke: a small script that tokenizes a `.ddd` file covering all new keywords and asserts every keyword is recognised.
- `web/e2e/` Playwright suite extended per (6).
- `web/test-fixtures/` updated if needed.

**Acceptance:**
- VS Code highlights every new keyword correctly.
- Playground editor highlights every new keyword correctly.
- Playground builders either handle new constructs or round-trip them as opaque without corruption — no silent data loss when saving back to `.ddd`.
- `playground-e2e.yml` green.
- `pages.yml` (docs site + playground build) green.

**Effort:** 3 days.

**Risks:**
- `system-v2` may have hardcoded AST shape assumptions. Audit *before* sizing this phase; if the audit reveals 1+ days of refactor work, extend the estimate accordingly and document scope in the tracking issue.
- TextMate grammar regexes can be fragile under combinations (e.g., `kind: state` vs `state` as a value vs `state:` as a property name elsewhere). Test against a comprehensive `.ddd` fixture covering all keyword positions.
- Monaco's token coloring may need theme-level updates if the playground uses semantic highlighting; verify against current theme before declaring complete.

---

### F5 — .NET adapter seam refactor (byte-identical)

**Goal:** Restructure `src/generator/dotnet/` into the adapter directory layout. Wrap the existing EF Core / cqrs / byLayer emitter as the **real** default adapters. **Output byte-identical** to current.

**Prerequisites:** F3.

**Deliverables:**

1. New directory structure under `src/generator/dotnet/`:
   ```
   src/generator/dotnet/
     index.ts
     surface.ts
     emit/                          # adapter-agnostic (DTOs, value objects, events, controllers)
     styles/
       cqrs/                        # REAL — wraps existing emitter
       layered/                     # STUB
     persistence/
       efcore/                      # REAL — wraps existing emitter
       dapper/                      # STUB
       marten/                      # STUB
     layouts/
       by-layer.ts                  # REAL — wraps existing path logic
       by-feature.ts                # STUB
     render-expr.ts                 # unchanged
     render-stmt.ts                 # unchanged
   ```

2. **Move existing code** into the right adapter subfolder; nothing changes semantically.

3. **Register all adapters** in `src/platform/registry.ts` for the dotnet entry. Stubs use the `stubAdapter` helper:
   ```typescript
   // Persistence adapters for .NET.
   // efcore is real; dapper and marten are stubs — implemented in follow-up streams C, D, E.
   persistence: {
     efcore: realEfcoreAdapter,
     dapper: stubAdapter("persistence", "dapper", "dotnet",
       () => realPersistenceNames(dotnetRegistry),  // lazily lists "efcore" once registry is built
       {
         name: "dapper",
         supportedStrategies: ["stateBased"],
         supports: (type, kind, strategy) =>
           strategy === "stateBased" &&
           ["postgres", "mysql", "sqlite", "inMemory"].includes(type) &&
           ["state", "snapshot", "replica"].includes(kind),
       }),
     marten: stubAdapter("persistence", "marten", "dotnet",
       () => realPersistenceNames(dotnetRegistry),
       {
         name: "marten",
         supportedStrategies: ["stateBased", "eventSourced"],
         supports: (type, kind, strategy) => type === "postgres",
       }),
   },
   // styles: cqrs is real; layered is a stub — follow-up stream A.
   styles: {
     cqrs: realCqrsStyle,
     layered: stubAdapter("style", "layered", "dotnet",
       () => realStyleNames(dotnetRegistry),
       {
         name: "layered",
         supportedStrategies: ["stateBased"],
         supportedLayouts: ["byLayer"],
       }),
   },
   // layouts: byLayer is real; byFeature is a stub — follow-up stream B.
   layouts: {
     byLayer: realByLayerLayout,
     byFeature: stubAdapter("layout", "byFeature", "dotnet",
       () => realLayoutNames(dotnetRegistry),
       { name: "byFeature" }),
   },
   ```

   Note the code comments above each stub block: they reference internal stream IDs for engineer wayfinding. These do **not** leak into user-facing error messages.

4. **Real `efcore` adapter must claim `eventLog` support too** (per RFC), but emitting an eventLog repository throws an `AdapterNotImplementedError` for an `"efcore-eventlog"` sub-capability. The capability declaration is correct; the implementation slot is stubbed.

5. **Real adapters' `emitOutbox`** returns null in this micro plan. Validator already requires integration events × transactional store; at emit time, if any aggregate has `publish: integration | both`, the build fails with a clear "outbox emission is not yet implemented" error. (Alternatively: emit a no-op outbox writer that logs to stdout — pick whichever is less surprising. **Recommendation:** error, not no-op, because silent-success is worse than failure for an integration-events feature.)

**Tests:**
- `test/generator/dotnet/seam-refactor.test.ts` — every existing fixture in `test/fixtures/dotnet-*` byte-identical.
- `test/generator/dotnet/stubs-throw.test.ts` — using `persistence: dapper`, `persistence: marten`, `style: layered`, `layout: byFeature`, `persistenceStrategy: eventSourced` (on any aggregate), or `publish: integration` produces the right error message at emit time.

**Acceptance:**
- All existing dotnet fixtures byte-identical.
- `LOOM_DOTNET_BUILD=1` still passes.
- Stubs throw with the documented messages.

**Effort:** 5 days. The largest phase of the micro plan; cannot be cut further without risking output divergence.

---

### F6 — Node adapter seam refactor + `platform: node` rename

**Goal:** Mirror F5 on Node. Rename `platform: node` → `platform: node { framework: hono }`. Wrap existing emitter as default. Stub everything else.

**Prerequisites:** F3. Independent of F4 and F5 (can run in parallel with both once F3 is merged).

**Deliverables:**

1. **`platform: node` → `platform: node { framework: hono }`**:
   - Grammar: accept `node` and `hono` as platform names; lower `hono` → `node { framework: hono }`.
   - Deprecation warning on the old form.
   - Update `examples/` and `web/src/examples/` to use the new form (coordinated single-PR, since all users internal).

2. **Restructure `src/generator/hono/` → `src/generator/node/`**:
   - Wrap existing emitter as the **real** default persistence adapter (name TBD by what's actually emitted — `drizzle`, `kysely`, or hand-rolled; pick the most accurate label).
   - Wrap existing dispatch as **real** `cqrs` or `layered` style — match what the current emitter does. If it doesn't fit neatly into either, pick the closer one and document the choice.
   - Wrap existing path logic as **real** `byLayer` layout.

3. **Stub registrations** in registry:
   - `persistence`: real default + one stub-ed alternate (label per F4-style stub) + one stub-ed ES adapter.
   - `styles`: real default + stub `layered` (or stub `cqrs` if real default is layered).
   - `layouts`: real `byLayer` + stub `byFeature`.
   - `frameworks`: real `hono` (only v1 value).

**Tests:**
- `test/parsing/platform-node.test.ts` — both forms parse; old form warns.
- `test/generator/node/seam-refactor.test.ts` — byte-identical for existing fixtures.
- `test/generator/node/stubs-throw.test.ts` — stubs throw at emit time.

**Acceptance:**
- All existing hono fixtures byte-identical under new keyword.
- `LOOM_TS_BUILD=1`, `LOOM_REACT_BUILD=1`, existing E2E suites green.

**Effort:** 3 days (smaller than F4 because no large generator pre-exists in the same shape).

---

### F7 — Phoenix adapter seam refactor

**Goal:** Mirror F5/F6 on Phoenix. Wrap Ash emitter as default. Stub `ashCommanded` and `contexts` style.

**Prerequisites:** F3. Independent of F4, F5, F6.

**Deliverables:**

1. Restructure `src/generator/phoenix/`:
   ```
   src/generator/phoenix/
     persistence/
       ashPostgres/                # REAL — wraps existing
       ashCommanded/               # STUB
     styles/
       ash/                        # REAL — wraps existing
       contexts/                   # STUB (R4: deferred unless maintainer signs up)
     layouts/
       byLayer/                    # REAL
   ```

2. Stub registrations in registry.

3. **Real Ash adapter must claim what it actually emits today**, no more (e.g., `supports(postgres, state|snapshot|replica, stateBased)`). ES on Phoenix throws `AdapterNotImplementedError("persistence", "ashCommanded", "phoenix", availableSiblings)`.

**Tests:**
- `test/generator/phoenix/seam-refactor.test.ts` — byte-identical for existing fixtures.
- `test/generator/phoenix/stubs-throw.test.ts` — `persistenceStrategy: eventSourced` on a phoenix deployable throws at emit time.

**Acceptance:**
- All existing phoenix fixtures byte-identical.
- `LOOM_PHOENIX_BUILD=1` still passes.

**Effort:** 3 days.

---

### F8 — Override and outbox stub wiring

**Goal:** `overrides { }` blocks parse and validate (already done in F1/F2) but at compose/emit time produce a "not yet implemented" error rather than silently being ignored. Same for outbox emission when integration events are declared.

**Prerequisites:** F5, F6, F7.

**Deliverables:**

1. **`src/system/index.ts`** — when computing the effective per-deployable storage set, if `deployable.storageOverrides.length > 0`, throw a build-time `AdapterNotImplementedError` (kind: `"override"`) with the standard message: `"Per-deployable storage overrides are declared on deployable '${name}' but per-deployable override resolution is not yet implemented."`

2. **Outbox emission stub** — already in F4 deliverable (4) above; documented here for completeness. Any aggregate with `publish: integration | both` causes the build to error with the standard "outbox emission is not yet implemented" message.

3. **`docs/old/proposals/storage-and-platform-config.md`** — flip `Status:` to "Foundation merged; feature implementations pending per phases listed below."

4. **`docs/old/proposals/storage-and-platform-config-micro-plan.md`** (this file) — add a "What's stubbed" appendix listing every error message and its tracking phase.

**Tests:**
- `test/generator/system/overrides-stubbed.test.ts` — a system with `overrides { }` builds without overrides but errors when emit is requested.
- `test/integration/integration-events-stubbed.test.ts` — an aggregate with `publish: integration` errors at emit.

**Acceptance:**
- All foundation behavior available; all features stubbed with discoverable error messages.

**Effort:** 1 day.

---

## Effort summary

| Phase | Effort | Delivery |
|---|---|---|
| F1 — Grammar + IR + lowering + per-feature validation | 5d | 6 small PRs (PR-1 through PR-6) |
| F2 — (absorbed into F1) | 0d | — |
| F3 — Adapter contracts + stub helper | 2d | 1 PR |
| F4 — Downstream consumer alignment (playground, VS Code, builders) | 3d | 1 PR |
| F5 — .NET seam refactor + stubs | 5d | 1 PR |
| F6 — Node seam refactor + rename | 3d | 1 PR |
| F7 — Phoenix seam refactor + stubs | 3d | 1 PR |
| F8 — Override + outbox stub wiring | 1d | 1 PR |
| **Total** | **~22 days** | **12 PRs** |

If F1's PR-1 through PR-4 run in parallel (two agents) and F4/F5/F6/F7 run in parallel after F3, wall-clock compresses to ~12 days.

---

## After this lands — parallel work streams

Each stream below picks up where the micro plan left off. They share **no dependencies** beyond the foundation, so they can run concurrently. Each stream replaces one stub with a real implementation.

| Stream | What it implements | Stub it replaces | Effort | Depends on |
|---|---|---|---|---|
| **A** | .NET layered style | `dotnet/styles/layered/` | 4d | F5 |
| **B** | .NET byFeature layout | `dotnet/layouts/by-feature.ts` | 1.5d | F5 |
| **C** | .NET Dapper persistence | `dotnet/persistence/dapper/` | 5d | F5 |
| **D** | .NET Marten persistence (ES) | `dotnet/persistence/marten/` | 6d | F5 |
| **E** | .NET EF Core eventLog | `dotnet/persistence/efcore/eventlog.ts` (new) | 4d | F5 |
| **F** | Outbox emission + publisher | per-adapter `emitOutbox` + publisher background service | 7d | D or E (any ES adapter); F5, F6, F7 |
| **G** | Per-deployable overrides resolution | `src/system/` override application | 4d | F5 |
| **H** | Node alternate persistence | `node/persistence/<alternate>/` | 4d | F6 |
| **I** | Node ES persistence | `node/persistence/<es-adapter>/` | 5d | F6 |
| **J** | Node layered style (if cqrs is default) | `node/styles/layered/` | 4d | F6 |
| **K** | Node byFeature layout | `node/layouts/by-feature.ts` | 1.5d | F6 |
| **L** | Phoenix ashCommanded (ES) | `phoenix/persistence/ashCommanded/` | 7d | F7 |
| **M** | Phoenix contexts style (optional) | `phoenix/styles/contexts/` | 7d | F7; maintainer signup |
| **N** | Builder UI for new constructs | full editing of `persistenceStrategy`, `publish`, platform config, logical storage, and overrides in `web/src/builder/system{,-v2}/` (beyond F4's round-trip baseline) | 4d | F4 |
| **O** | Final docs + examples | `docs/language.md`, `docs/generators.md`, `examples/` | 4d | All other streams complete enough to document |

**Total parallel effort:** ~68 days summed (incl. stream N for builder UI).
**Realistic wall-clock with 3 concurrent agents:** ~22–27 days from foundation merge to full feature parity.
**Realistic wall-clock with 5 concurrent agents:** ~14–20 days.

### Suggested parallel sequencing (3-agent example)

| Week | Agent 1 | Agent 2 | Agent 3 |
|---|---|---|---|
| 1 | A (layered) | C (Dapper) | H (Node alt) |
| 2 | B (byFeature) → D (Marten) | E (EF eventLog) | J (Node layered) |
| 3 | D (Marten) cont. | F (outbox) — needs D or E | K (Node byFeature) → I (Node ES) |
| 4 | G (overrides) | F (outbox) cont. | L (Phoenix ES) |
| 5 | N (builder UI) | O (docs) — all converge | L cont. → O |

Stream M (Phoenix contexts) is gated on maintainer signup per R4 and may not be picked up in v1.

---

## Stub error messages

User-facing messages tell the user **what isn't done** and **what is available** as a sibling. They do **not** reference internal plan/phase/stream names — users have no visibility into our roadmap.

The error class (`AdapterNotImplementedError`) carries:

- **Adapter kind**: `"persistence"` | `"style"` | `"layout"` (or `"outbox"` / `"override"` for the special cases).
- **Adapter name**: e.g., `"dapper"`, `"layered"`, `"byFeature"`.
- **Platform name**: e.g., `"dotnet"`, `"node"`, `"phoenix"`.
- **Available implementations**: sibling adapters of the same kind that ARE implemented today.

Standard message format:

```
${adapterKind} adapter '${name}' is not yet implemented for platform '${platformName}'.
Available implementations: ${comma-separated sibling names}.
```

If no sibling is implemented (rare in v1 but possible later):

```
${adapterKind} adapter '${name}' is not yet implemented for platform '${platformName}'.
No implementations of this ${adapterKind} are available yet.
```

Special-case messages (still no internal-plan references):

- **Outbox stub**: `"Outbox emission is required because aggregate '${name}' publishes integration events, but outbox emission is not yet implemented for platform '${platformName}'."`
- **Override stub**: `"Per-deployable storage overrides are declared on deployable '${name}' but per-deployable override resolution is not yet implemented."`
- **EF Core eventLog stub**: `"Event-sourced storage on 'efcore' is not yet implemented for platform 'dotnet'. To proceed today, change the aggregate to 'persistenceStrategy: stateBased' or wait for an event-sourcing-capable adapter."`

### Internal tracking lives in code comments

When registering a stub, add a code comment at the registration site referencing the internal stream/PR/issue. Example:

```typescript
// Stub — implemented by follow-up stream C (see storage-and-platform-config-micro-plan.md).
dapper: stubAdapter(...)
```

This is for engineer wayfinding; it does not appear in any user-facing artifact.

---

## Stub coverage checklist

Confirm before declaring foundation complete. Each row must be either ✓ real or ✓ stubbed:

| Surface | dotnet | node | phoenix |
|---|---|---|---|
| `persistence: <default>` | ✓ real (efcore) | ✓ real (TBD name) | ✓ real (ashPostgres) |
| `persistence: <alternate>` | ✓ stub (dapper) | ✓ stub (TBD) | n/a |
| `persistence: <es>` | ✓ stub (marten) + ✓ stub (efcore-eventLog) | ✓ stub (TBD) | ✓ stub (ashCommanded) |
| `style: cqrs` (or platform's default) | ✓ real | ✓ real | ✓ real (ash) |
| `style: layered` (or platform's alt) | ✓ stub | ✓ stub (if not default) | ✓ stub (contexts, deferred) |
| `layout: byLayer` | ✓ real | ✓ real | ✓ real |
| `layout: byFeature` | ✓ stub | ✓ stub | rejected (validator) |
| `persistenceStrategy: eventSourced` (aggregate) | ✓ stubbed via ES persistence stub | ✓ stubbed | ✓ stubbed |
| `publish: integration` (event) | ✓ stubbed (outbox) | ✓ stubbed | ✓ stubbed |
| `overrides { }` | ✓ stubbed (system orchestrator) | ✓ stubbed | ✓ stubbed |

Validator (F2) must accept all configurations in this table; emit (F4–F7) must produce real output for "real" rows and `AdapterNotImplementedError` for "stub" rows.

---

## Sequencing relative to PR #549 (type-system family)

PR #549 introduces a 33-week multi-track plan covering payload transport, aggregate inheritance, exception-less flow, and criteria. This micro plan slots into that roadmap at a specific position.

### Recommended overall sequence

```
Week 0          PR #514 merges (universal Type{} grammar)
                              │
Week 1–3        ┌─ Foundation phases F1+F2+F3+F4 ──────────────────┐
                │ My grammar + IR + validator + downstream         │
                │ (parallel: P-track P1 can start; I-track I1)      │
                └───────────────────────────────────────────────────┘
                              │
Week 4–6        ┌─ Foundation phases F5+F6+F7+F8 ──────────────────┐
                │ My platform seam refactors + stub wiring          │
                │ (parallel: P-track P2; I-track I2)                 │
                └────────────────────────────────────────────────────┘
                              │  ┄┄┄ Foundation merged ┄┄┄
                              │
Week 6–12       ┌─ My parallel streams A–N + I3+I4 ──────────────┐
                │ (.NET layered, Dapper, Marten, byFeature, outbox,│
                │  overrides, node/phoenix adapter implementations) │
                │ (parallel: P3+P4 carrier generics + unions)        │
                └──────────────────────────────────────────────────┘
                              │
Week 12–14      A1+A2+A3 (exception-less foundation)
                              │
Week 15         A4 (find-variant re-shape — touches my adapters)
                              │
Week 16–20      A5, A6, A7a, Crit1–5
```

### Why before, not after #549

**Position chosen: this micro plan lands BEFORE most of #549's work, in parallel with #549's I-track (aggregate-inheritance).**

Three reasons:

1. **My adapter seams accelerate A4.** Exception-less Phase A4 (re-shapes `Repo.getById → T or NotFound`) modifies every backend's repository emission. The `PersistenceAdapter.emitRepository(...)` contract signature established by this micro plan is stable under A4 — only the emitted code body changes. With the seam in place, A4 touches per-adapter files (efcore, dapper, marten) instead of monolithic per-backend emitters. **Landing my seam first makes A4 strictly easier.** Landing my seam after A4 forces me to refactor whatever A4 produces — wasted work.

2. **My grammar additions are independent of #549's grammar work.** This proposal adds keys to existing decl blocks (`storage`, `aggregate`, `event`, `deployable`); #549 adds new type-system constructs (`payload`, generics, ML-postfix, `or` unions, `?`, `error`, `criterion`, `option`). No grammar conflicts.

3. **Builder v2 will compete for attention with #549.** Doing my F4 (downstream consumer alignment) sooner, while the builder is still being shaped by the existing series (#518/#519/#542/#543), is cheaper than doing it after #549 reshapes the builder for type-system display.

### Coordination points

**Coord 1 — the word `storage` is overloaded; recommend renaming #549's aggregate-inheritance key.** This proposal uses `storage` as a top-level declaration keyword (`storage pg { ... }`, `storage orderDb { use: pg, for: ... }`). #549's `aggregate-inheritance.md` uses `storage:` as an aggregate-property key for inheritance table layout (`abstract aggregate Party storage: shared`). Same word, two genuinely different concepts — readability suffers.

**Recommendation**: rename #549's `storage: shared | own` to `inheritanceStrategy: shareTable | ownTable` (or `tableInheritanceStrategy:` if maximal explicitness is wanted). The aspects then read distinctly:

```ddd
storage pg { type: postgres }                                 # top-level: a physical instance
storage orderDb { use: pg, for: Sales.Order }                 # top-level: a logical binding

abstract aggregate Party {
  inheritanceStrategy: shareTable                              # aggregate property: TPH layout
}

aggregate Customer extends Party {
  persistenceStrategy: stateBased                              # aggregate property: persistence model
}
```

Two small clean-ups baked into this example versus #549's draft:
- The `inheritanceStrategy:` key lives **inside** the `aggregate { ... }` block, not floating between the name and the block. Loom convention: only modifiers (like `abstract`) appear before the keyword; values are attributes inside.
- Loom doesn't shorten obvious words. `inheritanceStrategy:` (vs. `storage:`) and `shareTable | ownTable` (vs. `shared | own`) trade a few characters for self-explanatory reading.

The underlying *concepts* are orthogonal (top-level resource decl vs aggregate-property table-layout choice, and within aggregate properties: persistence model vs inheritance layout). Only the word `storage` was overloaded; the rename removes the overload.

The one **intersection corner case** worth pinning at implementation time:

> Can a concrete subtype with `persistenceStrategy: eventSourced` extend an abstract base with `inheritanceStrategy: shareTable` (TPH)? Three options: validator rejects; allow with projection-into-parent semantics; force ES subtypes to `inheritanceStrategy: ownTable` (TPC).

Recommendation: option 3 (force `inheritanceStrategy: ownTable` for ES subtypes). Simplest, no derived-state-inside-inheritance-table magic. To be decided jointly with the #549 author once both proposals reach implementation; not a foundation-phase blocker.

**Coord 2 — fixture re-baseline calendar.** A4's coordinated fixture re-baseline (their M3) and my foundation's adapter seam refactor both touch every fixture in different ways. **Mine lands first** (week 4–6), establishing per-adapter fixture organisation. A4 (week 15) then re-baselines fixture *contents* per the new return shapes. The two operations don't conflict because they touch fixtures along different axes (structure vs content), but the calendars need to be sequential, not overlapping.

### What this position requires from me

- **Read #549's `aggregate-inheritance.md` and `implementation-plan.md`** before starting F1 (done as part of this audit).
- **Add cross-references** in this proposal pointing at the relevant #549 docs (done).
- **Avoid #549's grammar surface area** in F1 — no new top-level keywords that compete with `payload`, `error`, `criterion`. None planned anyway.
- **Raise the `storage:` → `inheritanceStrategy:` rename with the #549 author** before either proposal lands. The conflict is the word `storage` being overloaded across a top-level keyword (mine) and an aggregate-property key (theirs). **TODO before F1.**
- **Surface the ES-subtype-in-TPH-inheritance corner case** to the #549 author as the one real semantic intersection point. **TODO before F1 starts emitting repository code that would force a resolution.**
- **Document the post-A4 churn expectation** so the agents picking up streams D (Marten) and E (EF Core eventLog) know their `emitRepository` will be revisited by A4's per-adapter touch-up. **TODO during F3 design.**

### What #549's plan should know about this proposal

If the type-system family's implementation-plan.md gets revised post-merge of this proposal, it should add:

- A note in A4's "Per-backend lowering" section: "Backends now route through `PersistenceAdapter.emitRepository(...)` per `storage-and-platform-config-micro-plan.md` F5/F6/F7. A4's repository-shape change lives in each adapter file, not in the platform's monolithic emitter."
- A decision pin in the D-table for renaming the inheritance key: "Rename `aggregate-inheritance.md`'s `storage: shared | own` to `inheritanceStrategy: shareTable | ownTable` to avoid lexical conflict with `storage-and-platform-config.md`'s top-level `storage` keyword. The aspects are orthogonal but the shared word forces context-switching."
- A note in `aggregate-inheritance.md`'s open-questions / future-work section: "Interaction with `aggregate { persistenceStrategy: eventSourced }` from the storage RFC is a known corner case. Recommended resolution: force `inheritanceStrategy: ownTable` (TPC) for ES subtypes; validator error otherwise. To be confirmed at the implementation intersection."

These are coordination notes for the #549 author to fold in; not unilateral edits I should make to their PR.

---

## Why this approach minimizes risk

1. **Grammar / IR / validator lock first** — Once F1–F2 land, no follow-up stream needs to touch the language layer or the validator. Any future feature work is purely in `src/generator/<platform>/<adapter>/` files.
2. **Byte-identical refactor before stubs** — F4/F5/F6 prove the seam works without behavior change. Stubs only after the refactor is green.
3. **Stubs are visible, not silent** — A user writing `persistence: dapper` in v0 of this work gets a clear error pointing at the implementation stream. No quiet defaults swapping in unexpectedly.
4. **Streams have minimal cross-talk** — Each adapter implementation touches files in one subdirectory. Merge conflicts between streams are limited to the platform's registry entry, which is small.
5. **Acceptance gates are mechanical** — "Stubs throw with the documented message" and "existing fixtures byte-identical" are easy to verify.

---

## Risks specific to the foundation

| Risk | Phase | Mitigation |
|---|---|---|
| The "byte-identical refactor" test catches a subtle reformatting drift | F4, F5, F6 | Use `scripts/capture-baseline-fixture.mjs` to refresh fixtures *only* after manual review of every diff line |
| Stub `supports()` declarations diverge from real adapter capabilities when those adapters land | F4 | Foundation stubs declare the same capabilities the real adapters will, per RFC §7.2. Document each capability matrix entry in code comments next to the stub |
| Coordination overhead between F4/F5/F6 if run in parallel | F4–F6 | Land F3 first; only then split. Each platform's refactor is self-contained |
| Internal `.ddd` files break under the `hono` → `node` rename | F5 | Synchronous rename PR coordinated with downstream projects; deprecation warning provides a grace period within the same release |

---

## Definition of done (the foundation)

All of the following must be true before any parallel stream starts:

1. `npm test` green.
2. `LOOM_TS_BUILD=1`, `LOOM_REACT_BUILD=1`, `LOOM_DOTNET_BUILD=1`, `LOOM_PHOENIX_BUILD=1` green.
3. Every cell in the "Stub coverage checklist" is verifiably either real or stubbed.
4. Every stub throws `AdapterNotImplementedError` with the documented tracking phase.
5. RFC `Status:` line updated to "Foundation merged; feature implementations in progress per the parallel streams listed in `storage-and-platform-config-micro-plan.md`."
6. Branch `feat/storage-redesign-foundation` merged to `main` (or to the long-lived `feat/storage-redesign` integration branch, depending on team preference).
7. Tracking issue lists every parallel stream with checkboxes and links to whoever's picking it up.

After (7), parallel work begins.
