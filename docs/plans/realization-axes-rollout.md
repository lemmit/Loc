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

## Phase 3 — `hono → node` rename + `hono` as `transport:` (D-NODE-PLATFORM)

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

## Phase 4 — Codegen axis consumption (keystone)

The F5d/F6d/F7d orchestrator rewire: make each backend's `emitProject` dispatch
through `resolve*` using the deployable's selection, so the axes stop being
inert.

- System orchestrator passes `deployable.{application,persistence,
  directoryLayout}` into the platform surface's emit path.
- Each backend's `emitProject` resolves its adapters via
  `resolvePersistence/Style/Layout(platform, deployable.<axis>)` instead of the
  hardcoded default path.
- **Byte-identical-fixture discipline** (the same gate used for the
  `WalkerTarget` extractions): with today's size-1 real menus the output must be
  unchanged; the wire-spec JSON Schema diff must be empty.
- **Verification:** all `LOOM_TS_BUILD` / `LOOM_DOTNET_BUILD` /
  `LOOM_PHOENIX_BUILD` + conformance-parity green; fixture diffs empty.

Highest effort/risk; **everything downstream is inert until this lands.**

## Phase 5 — Grow the menus (stub adapters → real)

Implement the reserved stub adapters so a selection has observable effect and
the menus go size-1 → size-N:

- dotnet: `dapper`, `marten` (persistence); `serviceLayer` (style/`application`);
  `byFeature` (layout/`directoryLayout`).
- node: `express` / `fastify` (transport); `prisma` (persistence).
- Activate gating **R2** (`directoryLayout: byFeature` × `serviceLayer|flat`)
  and **R3** (`serviceLayer|flat` × event-sourced) as those values become real
  — R3 lands in `src/ir/validate/validate.ts` (it's an aggregate-cross-ref).

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
