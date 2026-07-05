# Realization-axes rollout — phase plan

> **[2026-06-20 status audit]** 'Done' is understated — the Phase 1 validator ships R1+R3+R4+R6 (`deployable.ts`); Phase 2's `phoenixLiveView→phoenix` is superseded by D-ELIXIR-PLATFORM (`→elixir`); transport/runtime are now adapter-backed (`platform/elixir.ts`, `platform/dotnet.ts`).

> **[2026-07-05 status audit — corrects two claims above/below]** Code-verified against `main`:
> 1. **transport/runtime are menu-backed, not emit-backed.** They carry adapter *menus* on
>    the platform surface — the validator reads them via `availableAdapterNames(family,
>    "transport"|"runtime")` (`src/language/validators/data/platform-rules.ts:227-229`) — but
>    neither has an emit-time consumer: `resolveTransport` / `resolveRuntime`
>    (`src/platform/resolve-adapters.ts`) have **zero call sites**. The 2026-06-20 "adapter-backed"
>    wording overstates them; read it as "carry a validator menu."
> 2. **`persistence:`'s first emit consumer landed (Phase 5c/5d) but as a raw-key branch, not
>    adapter dispatch.** The dotnet/node orchestrators branch on the `deployable.persistence`
>    string key (14 such branches in `src/generator/dotnet/index.ts`); the `PersistenceAdapter`
>    object is **not** threaded through `EmitCtx`, and `resolvePersistence()` remains **uninvoked**
>    (its only references are its own definition + a comment). The adapter object feeds the
>    validator's axis menu (`availableAdapterNames`), not emission. So the Phase 4 "threads when
>    Phase 5 adds one" promise below is only half-kept: the consumer arrived, the adapter-threading
>    did not.

> Status: **planning**. Sequences the work that turns the pinned
> realization-axes design (**D-REALIZATION-AXES**, **D-NODE-PLATFORM**,
> **D-PHOENIX-SURFACE**) into shipped behaviour. Each phase is independently
> mergeable, build+lint+fast-suite green, with `LOOM_*`-gated builds run in CI.

## Done

- **Phase 1 — Surface + validation.** Grammar `platform: <name> { … }` block,
  six axes on `DeployableIR`, lowering defaults from `defaultsFor`, validator
  R1 + R4, real-vs-stub menu derivation. No codegen behaviour change.
  (`platform-realization-axes.md`.)
- **Phase 2 — `phoenixLiveView → phoenix` rename.** Canonical platform literal
  flipped; `phoenixLiveView` retained as a back-compat alias; platform/framework
  conflation disentangled (the LiveView *framework* keeps `phoenixLiveView`).
  (D-PHOENIX-SURFACE.)
- **Phase 3 — `hono → node` rename.** Canonical JS-runtime platform is `node`;
  `hono` desugars to it and lives on as the `transport:` framework value.
  (D-NODE-PLATFORM.)
- **Phase 4 — Codegen axis consumption (keystone).** The system orchestrator
  resolves each backend deployable's `application:` (→ style) and
  `directoryLayout:` (→ layout) selection via `resolve-adapters` and threads the
  resolved adapters through `emitProject` → the generator's `EmitCtx`; the
  per-aggregate dispatch (dotnet/node) and config DI (phoenix) use the threaded
  adapter, falling back to the sibling default in legacy single-context mode.
  Byte-identical under today's size-1 real menus (baseline-fixture + conformance
  gates green); end-to-end threading covered by
  `test/platform/realization-axes-emit-wiring.test.ts`. `persistence:` has no
  live emit-dispatch consumer yet — its first consumer lands in Phase 5c/5d, but as
  a `deployable.persistence` key-branch, **not** the adapter-threading this line
  anticipated (see the 2026-07-05 audit note above).

## Phase 3 — `hono → node` rename + `hono` as `transport:` (D-NODE-PLATFORM) — **DONE**

Mirror Phase 2's pattern for the JS world. **Bigger blast radius** — `hono` is
the most-used backend across tests/examples — and the same platform/framework
disentanglement applies (the *runtime* → `node`; the *web framework* → a
`transport:` value).

- `Platform` IR union: add `node` (keep nothing else; `hono` leaves the union).
- Grammar `Platform` rule: add `node`, keep `hono` as a back-compat keyword.
- `registry.ts`: `node` canonical key/family/surface name; `aliasPlatform`
  maps legacy `hono` → `node`; `BUILTIN_PLATFORM_LATEST` key `node`.
- `transport:` menu for `node` = `hono`\* (default) — size-1 until Phase 6 adds
  `express`/`fastify`; legacy `platform: node` desugars to
  `node { transport: hono }`.
- Add the **derived `language` property** to `PlatformSurface`
  (`node`→`typescript`, `dotnet`→`csharp`, `phoenix`→`elixir`, `react`→
  `typescript`) for the eventual Phase-F shared-contracts grouping.
- `src/platform/hono/` reframed in docs/comments as "node's Hono transport";
  `src/generator/typescript/` is the (unchanged) language codegen.
- Update tests/examples to the new canonical with back-compat assertions
  (`platform: node` → `"node"`), exactly as Phase 2 did for phoenix.
- **Verification:** build + lint + full fast suite; `hono-build.yml` (the
  TS/tsup gate) is the CI check for the emit path. Surface-only — no output
  change (transport stays `hono`).

*Independent of Phase 4; can land any time (or fold into Phase 6 when
`transport` codegen is real).*

## Phase 4 — Codegen axis consumption (keystone) — **DONE**

The F5d/F6d/F7d orchestrator rewire: make each backend's per-aggregate dispatch
run through the deployable's resolved adapter selection, so the axes stop being
inert.

As shipped (the layering invariant — no `src/generator/* → src/platform/*`
edges — shaped the seam):

- The **system orchestrator** (`src/system/index.ts`, the layer allowed to
  import `resolve-adapters`) resolves `deployable.application` (→ `resolveStyle`)
  and `deployable.directoryLayout` (→ `resolveLayout`) for backends, then passes
  the resolved adapter OBJECTS into `PlatformSurface.emitProject` via two new
  optional args.
- Each surface FORWARDS the resolved adapters into its generator's `EmitCtx`
  (`styleAdapter` / `layoutAdapter`).  The per-aggregate dispatch uses
  `emitCtx.styleAdapter ?? <sibling default>` (dotnet/node: style + layout;
  phoenix: style only, for config DI).  Legacy single-context generate mode
  passes none → sibling fallback → unchanged output.
- **`persistence:` deferred** — no backend invokes a persistence adapter through
  `EmitCtx` yet (efcore is internal, drizzle is a static constant), so threading
  it would be inert plumbing.  Its first consumer landed in Phase 5c/5d — but as a
  `deployable.persistence` key-branch, so the `PersistenceAdapter` is still not
  threaded through `EmitCtx` and `resolvePersistence()` stays uninvoked (2026-07-05 audit).
- **Byte-identical** under today's size-1 real menus: baseline-fixture
  (`page-emitter-equivalence`) + conformance-parity green, wire-spec diff empty.
  End-to-end threading (sentinel-adapter injection through the public
  `emitProject` arg) covered by
  `test/platform/realization-axes-emit-wiring.test.ts`.
- **Verification:** build + lint + fast suite green; the `LOOM_*_BUILD` gates run
  in CI.

## Phase 5 — Grow the menus (stub adapters → real)

Implement the reserved stub adapters so a selection has observable effect and
the menus go size-1 → size-N:

- **5a — dotnet `byFeature` layout — DONE.** First real dotnet layout: the
  `directoryLayout: byFeature` selection relocates each aggregate's application +
  API artifacts (commands / queries / handlers / DTOs / controller) under
  `Features/<Plural>/` (vertical-slice), delegating the rest to `byLayer`.
  `availableAdapterNames("dotnet","layout")` now `["byFeature","byLayer"]`; the
  R1 "reserved stub" rejection for `byFeature` flips to accepted. **R2 stays
  unreachable** (every real style supports both layouts).
- **5b — `byFeature` becomes a COMPLETE feature layout — DONE.** Routed the
  remaining per-aggregate emissions in `emitAggregate` — entity (root / parts /
  abstract base / snapshots), repository interface + impl, EF config (relational +
  document), join tables, document POCO — through the threaded layout adapter, so
  `byFeature` now colocates the WHOLE vertical slice (domain + persistence +
  application + API) under `Features/<Plural>/`. Cross-cutting / shared
  artifacts (context-level Domain primitives, shared Infrastructure like the
  DbContext / dispatcher / migrations, per-context views / workflows, the Tests
  project, the root) stay layered. Added one byLayer category (`document-poco`);
  snapshots reuse `entity`, the document config reuses `ef-configuration`.
  As 5b shipped this was a pure relocation (contents identical, namespaces
  still layered — path-independent C# namespaces + the `**/*.cs` csproj glob
  made it compile by construction); 5e below made the namespaces follow.
- **5e — dotnet namespace-by-feature — DONE.** A relocated file's C# namespace
  now MIRRORS its feature folder (`Features/Orders/Commands/CreateOrder.cs` →
  `namespace <Ns>.Features.Orders.Commands;`) instead of keeping the byLayer
  shape, making the output idiomatic vertical-slice C#. The emitters stay
  layout-agnostic (they always author byLayer namespaces); a post-emit pass
  (`src/generator/dotnet/layout-namespaces.ts`, the dotnet analogue of the TS
  `layout-imports.ts` relative-import rewrite) rewrites the namespace
  declarations plus every reference project-wide: `using` directives —
  including SPLIT namespaces like `Infrastructure.Repositories` that scatter
  across features (expansion is reference-tested per file; surviving old
  namespaces are kept; duplicates collapse — CS0105 is fatal under
  `/warnaserror`) — fully-qualified references (Program.cs DI registrations,
  extern-handler startup checks), and namespace-RELATIVE references
  (AppDbContext's `Configurations.X`, re-anchored `global::` because a bare
  `<Ns>.…` inside a namespaced file mis-binds against `<Ns>.Api`). The feature
  folder switched singular → PLURAL (`Features/Orders/`) as the load-bearing
  precondition: C# resolves simple names against enclosing namespaces before
  `using`s, so a singular segment (`namespace <Ns>.Features.Order` + `class
  Order`) would break cross-feature references like `class Customer : Party`
  with CS0118; plural segments keep namespace segments and type names disjoint
  (same reason byLayer's plural folders never collided). byLayer remains
  byte-identical (the pass no-ops when nothing relocated). **Compile-gated**
  (the node lesson applied): `test/e2e/fixtures/dotnet-build/byfeature.ddd` —
  packing TPH inheritance, an extern handler, a join-table association, an
  event-sourced aggregate, and a view — builds under `dotnet build
  /warnaserror` in `build-generated-dotnet`.
- **5c — dotnet `dapper` persistence (minimal-v1) — DONE.** First alternate
  persistence adapter: `persistence: dapper` emits an Npgsql/Dapper Infrastructure
  (per-aggregate repository with hand-built SQL — upsert / getById / findManyByIds
  / finds via an `ExprIR`→SQL renderer — plus a self-applied `DbSchema`
  CREATE-TABLE bootstrap, an `NpgsqlDataSource` registration, and Dapper/Npgsql
  deps) reusing the persistence-agnostic Domain layer via the
  `<Agg>._Create(State)` hydration seam.  The orchestrator branches on the
  deployable's resolved `persistence` key (efcore path byte-identical).  v1 is
  validator-gated (`loom.dapper-unsupported` in `ir/validate/validate.ts`):
  relational + state-based, flat aggregates with scalar / enum / value-object /
  id-ref fields; rejects document/embedded shape, associations, nested parts,
  inheritance, event-sourcing, audit/provenance/managed fields, retrievals,
  seeds.  Compile-gated: `test/e2e/fixtures/dotnet-build/dapper.ddd` is built
  under `dotnet build /warnaserror` (`build-generated-dotnet`).
  `availableAdapterNames("dotnet","persistence")` → `["dapper","efcore"]`.
- **5d — node `mikroorm` persistence (minimal-v1) — DONE.** Second node
  persistence adapter (alongside the default `drizzle`): `persistence: mikroorm`
  emits an idiomatic MikroORM `db/` layer — an `EntitySchema` persistence model
  (`db/entities.ts`) separate from the rich domain aggregates, a
  `mikro-orm.config.ts`, and per-aggregate repositories using the `EntityManager`
  the way a MikroORM dev would (`em.fork()`, `findOne`/`find` with real
  `FilterQuery` objects, `em.upsert`, `em.nativeDelete`; schema owned by
  `orm.schema.updateSchema()` at startup, so no drizzle migrations).  Row↔domain
  mapping reuses Loom's shared `hydrateRootExpr` / `projectionObject` /
  `toWireMethod` so it stays byte-consistent with the drizzle hydrate.  The
  orchestrator branches on the deployable's resolved `persistence` key
  (`platform/hono/v4/emit.ts`; drizzle path byte-identical).  Validator-gated
  (`loom.mikroorm-unsupported`): relational, state-based, flat aggregates with
  scalar / enum / value-object / id-ref fields; document/embedded shape,
  associations, nested parts, inheritance, event-sourcing,
  audit/provenance/managed fields, retrievals and seeds are rejected.
  Compile-gated: `test/e2e/fixtures/ts-build/mikroorm.ddd` is `tsc`/`tsup`-built
  against the real `@mikro-orm/*` types (`build-generated`).  The node
  persistence menu is now exactly `{ drizzle, mikroorm }` (the speculative
  `prisma` stub was removed).
- **dotnet persistence — grow each adapter to FULL before adding a third.** The
  near-term work is event-sourcing (`persistedAs(eventLog)` + `apply(...)`) on
  **`efcore` first, then `dapper`** (an `<agg>_events` table folded through the
  appliers — workflow-and-applier.md Phase A2.2), so both shipped adapters reach
  the full surface drizzle already has. A dedicated **`marten`** document/event-
  store backend is **3rd priority (if ever)** — `D-DOCUMENT-AXIS` pins *no new
  Marten backend*, so the event log lives on the existing relational stores; the
  stub stays inert (and may be dropped) until/unless that decision is revisited.
- dotnet: `serviceLayer` (style/`application`).
- node: `express` / `fastify` (transport).
- **node `byFeature` layout — DONE (proper, with import rewriting).** A first
  naive port (#830, reverted) shipped broken: unlike .NET `using <Namespace>`
  (path-independent), generated TS files import each other by **relative path**,
  so relocating them to `features/<agg>/` without rewriting specifiers yields
  non-compiling output. The proper landing keeps the shared
  `src/generator/typescript/` emitters layout-agnostic and adds a **post-emit
  import-rewrite pass** (`layout-imports.ts:rewriteRelativeImports`): from the
  layout adapter's old→new mapping it fixes every relative specifier (static
  `from`/`import`, `export … from`, AND dynamic `import("…")` — the lazy
  `obs/log` load) in both relocated files and the shared files that import them.
  No-op when nothing moved → byLayer byte-identical. **Compile-gated:** a
  system-mode fixture (`test/e2e/fixtures/ts-build/byfeature.ddd`) selects
  `node { directoryLayout: byFeature }` and the `build-generated-ts` job
  `tsc --noEmit`s + tsup-bundles the relocated project. (The dynamic-`import`
  miss was caught by that real compile — which the in-suite dangling-import
  check, sharing the same regex, had missed. Lesson applied: a layout MUST have
  a compile gate.)
- Activate gating **R2** (`directoryLayout × application`) once a real style does
  NOT support a real layout, and **R3** (`serviceLayer|flat` × event-sourced) as
  those values become real — R3 lands in `src/ir/validate/validate.ts` (it's an
  aggregate-cross-ref).

Each adapter is a contained unit with its own emit tests + a CI build.

## Phase 6 — Greenfield-axis codegen

The three axes with no adapter infra today:

- **`foundation:`** — `abp` (dotnet, rung-4), `nestjs` (node, rung-3). Activates
  **R4** broadly (foundation locks `application`/`transport`/persistence-flavor).
- **`transport:`** — `controllers` (dotnet), `express`/`fastify` (node).
- **`runtime:`** — `orleans`/`akka` (dotnet), `genserver` (phoenix) actor
  hosting. Activates **R5** (durable-store check) and **R7** (`flat` × actor
  warning).

Large per-axis features; one major addition per cycle (roadmap cadence).

## Future — additional JS runtimes

`bun` / `deno` / `edge` (workerd) as **sibling `platform:` values**
(D-NODE-PLATFORM), all TypeScript — distinct stdlib/deploy, sharing the
`typescript` codegen + the `transport`/`foundation`/… axes. Decide at that point
whether the shared codegen warrants a project-shell abstraction (Phase H of the
platform-expansion roadmap).

## Sequencing summary

- **3** independent (mirror of Phase 2) — do now or fold into 6.
- **4** is the keystone — unblocks observable effect for 5 & 6.
- **5** and **6** depend on 4; each axis/adapter ships incrementally behind its
  CI build gate.

## Related

- `docs/decisions.md` — D-REALIZATION-AXES, D-NODE-PLATFORM, D-PHOENIX-SURFACE,
  D-ADAPTER-HOME.
- `docs/proposals/platform-realization-axes.md` — the axis design + gating
  matrix.
- `docs/plans/platform-expansion-roadmap.md` — the orthogonal "new platforms"
  track (Vue, FastAPI, Blazor…); Phase H (project-shell) is shared with the
  Future section here.
