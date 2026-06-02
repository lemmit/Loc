# Realization-axes rollout — phase plan

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
  live emit-dispatch consumer yet — it threads when Phase 5 adds one.

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
  `express`/`fastify`; legacy `platform: hono` desugars to
  `node { transport: hono }`.
- Add the **derived `language` property** to `PlatformSurface`
  (`node`→`typescript`, `dotnet`→`csharp`, `phoenix`→`elixir`, `react`→
  `typescript`) for the eventual Phase-F shared-contracts grouping.
- `src/platform/hono/` reframed in docs/comments as "node's Hono transport";
  `src/generator/typescript/` is the (unchanged) language codegen.
- Update tests/examples to the new canonical with back-compat assertions
  (`platform: hono` → `"node"`), exactly as Phase 2 did for phoenix.
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
  it would be inert plumbing.  It threads in Phase 5 alongside its first consumer.
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
  `Features/<Aggregate>/` (vertical-slice), delegating the rest to `byLayer`.
  `availableAdapterNames("dotnet","layout")` now `["byFeature","byLayer"]`; the
  R1 "reserved stub" rejection for `byFeature` flips to accepted. **R2 stays
  unreachable** (every real style supports both layouts).
- **5b — `byFeature` becomes a COMPLETE feature layout — DONE.** Routed the
  remaining per-aggregate emissions in `emitAggregate` — entity (root / parts /
  abstract base / snapshots), repository interface + impl, EF config (relational +
  document), join tables, document POCO — through the threaded layout adapter, so
  `byFeature` now colocates the WHOLE vertical slice (domain + persistence +
  application + API) under `Features/<Aggregate>/`. Cross-cutting / shared
  artifacts (context-level Domain primitives, shared Infrastructure like the
  DbContext / dispatcher / migrations, per-context views / workflows, the Tests
  project, the root) stay layered. Added one byLayer category (`document-poco`);
  snapshots reuse `entity`, the document config reuses `ef-configuration`. Pure
  relocation — identical file CONTENTS, only paths differ (namespaces stay
  layered; namespace-by-feature is a later slice). `byLayer` default stays
  byte-identical (baseline fixture unchanged); compiles by construction (C#
  namespaces are path-independent, `.csproj` globs `**/*.cs`).
- **5b (node) — hono `byFeature` layout — DONE.** Brings `directoryLayout:` to a
  SECOND backend, same pure-relocation pattern. `platform: node { directoryLayout:
  byFeature }` colocates each aggregate's domain module / drizzle repository /
  HTTP routes / extern / test (and the TPH/TPC base union + reader) under
  `features/<agg>/`; pooled domain (ids / value-objects / events / errors),
  `db/schema.ts`, `http/index.ts`, views / workflows, obs / auth / lib, and the
  root stay layered. byFeature reuses byLayer's basenames (file names stay
  byte-identical, only the folder changes). `byLayer` default unchanged;
  type-checks unchanged (TS resolves relative imports regardless of folder).
- dotnet: `dapper`, `marten` (persistence); `serviceLayer` (style/`application`).
- node: `express` / `fastify` (transport); `prisma` (persistence).
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
