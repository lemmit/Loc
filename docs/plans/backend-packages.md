# Backend packages — versioned platform generators

> **Status:** design proposal for review. No code yet. Supersedes
> the `stacks/<backend>` idea in `stack-versioning.md` (kept there
> only for historical context, flagged superseded).

## The problem

Frontend versioning is solved by two *data* axes:

- **design pack** (`designs/<family>/<vN>/`) — templates + a manifest.
- **stack** (`stacks/<id>/`) — the React/router/zod baseline a pack
  runs on.

Both work because the *generator code doesn't change* — only the
data it consumes. React 18→19 was a dep+bundler-hint flip; Tailwind
3→4 was a config-shape flip; even Chakra 2→3 was "swap the template
strings".

A **backend is not data — it is code.** Each backend is a
`PlatformSurface` impl (`src/platform/<name>.ts`) delegating to a
`src/generator/<platform>/` tree of procedural emitters,
`render-expr`/`render-stmt`, project structure, Dockerfile, and
compose wiring. A real major bump is *generator-logic* change:

- .NET 8 → 10: MediatR 2 → 14 (total handler/pipeline API change),
  EF Core, minimal-API shape, C# language version.
- Hono 4 → 5: middleware/context API shifts.
- Phoenix scaffold-convention churn across majors.

You cannot express "MediatR 2 → 14" as a dep-pin swap — the emitted
CQRS handlers, DI registration, and pipeline behaviours are
different *code*. So a backend major must be modelled as **a
separate generator package**, with the previous one retained for
projects that haven't migrated.

The current registry can't express this — it is single-version:

```ts
// src/platform/registry.ts (today)
const platforms: Record<Platform, PlatformSurface> = {
  dotnet, hono, react, static: reactPlatform, phoenixLiveView,
};
```

`Platform` is a closed union (`"dotnet" | "hono" | …`); there is
exactly one dotnet generator, one hono generator. Replacing one
breaks every project pinned to it.

## The vision (owner's framing)

> Separate packages that implement **target IR**, **final
> lowering**, and **templating**. Change version / create a new
> backend package when there is a major thing to change; keep the
> previous to support.

This maps cleanly onto the existing pipeline. The shared, neutral
contract stays **Loom IR** (`src/ir/loom-ir.ts`) — fully resolved,
platform-neutral; backends never re-resolve names/types. What a
backend package owns is the per-platform slice *after* Loom IR:

| Slice | What it is today | In the package model |
| --- | --- | --- |
| **Target IR shaping** | Implicit: `reservedRepositoryFindNames` on the surface, ad-hoc per-platform reads of `wireShape`/derived data, DTO-mapping helpers (`dotnet/dto-mapping.ts`) | An explicit per-package step that derives the platform-specific view from Loom IR (reserved names, wire/DTO shaping, platform capability flags). Pure; Loom IR in, target-IR out. |
| **Final lowering** | `src/generator/<plat>/render-expr.ts` + `render-stmt.ts` — Loom `ExprIR`/`StmtIR` → target-language syntax | Owned by the package. This is the part that *actually differs* between a backend's majors (e.g. C# minimal-API vs controllers). |
| **Templating** | `index.ts` orchestrator + `*-emit.ts`/`*-builder.ts` + `emit/` + `composeService` | Owned by the package: project structure, framework wiring, Dockerfile, dep pins (`BACKEND_PINS`). |

`PlatformSurface` (`src/platform/surface.ts`) is already the right
seam — `emitProject` / `composeService` / capability flags. A
versioned backend is just **another `PlatformSurface`
implementation, discovered by the registry under a `family@version`
key**, internally structured as the three slices above.

## Versioning model

Mirror the *proven* `design:` machinery exactly — it already does
family@version resolution end to end and is the lowest-risk
precedent.

- **Registry**: `Record<Platform, …>` → a family+version map.
  `platformFor("hono")` resolves the bareword via
  `BUILTIN_PLATFORM_LATEST.hono` (LTS-style default);
  `platformFor("dotnet@v10")` pins. Old versions are distinct
  registered modules, coexisting.
- **Grammar**: add `| STRING` to the `Platform` rule in
  `ddd.langium` — the same one-line change `DesignPack` already has
  (`'mantine' | … | STRING`). No grammar-shape risk; the STRING
  alternative is a known-good pattern. Bareword keywords still
  parse.
- **Validator + lowering**: reuse the `parseBuiltinDesignRef` /
  `qualifyDesign` shape from `builtin-formats.ts` / `lower.ts`,
  generalised to platforms (`parseBuiltinPlatformRef`,
  `BUILTIN_PLATFORM_LATEST`). Lowering writes the fully-qualified
  `family@version` into the IR so the orchestrator never
  re-resolves — identical to how `design` is qualified post-lower.
- **DSL surface**: `platform: "hono@v5"` (quoted pin, symmetric
  with `design: "mantine@v9"`); bareword `platform: node` →
  default. Preferred over a separate `stack:` slot — one less
  concept, full symmetry with packs.

### Directory layout

```
src/platform/
  registry.ts                 (family@version map + defaults)
  surface.ts                  (unchanged contract)
  hono/
    v4/{surface.ts, target-ir.ts, lower.ts, templating/…}
    v5/{surface.ts, …}        (imports v4's stable slices, overrides changed ones)
  dotnet/
    v8/…  v10/…
  phoenix/
    v1/…  v2/…
```

Shared logic is shared by **ordinary imports**, not duplicated: a
`v5` package imports the prior version's stable emitters/renderers
and overrides only the slice the major actually changed. This is
the "package discovered by core" shape — and it keeps a backend
major honest about being a code change, not a config swap.

### Layering invariant (load-bearing)

**Edges point one way: `package → shared`, never `shared → package`.**
`src/generator/<emitter>/` must not `import` anything from
`src/platform/<family>/<vN>/`. Per-version data the emitter needs
(dep pins today; framework-wiring hooks tomorrow) is **passed in as
a parameter** by the package's surface (and by entrypoints — CLI,
tests — which compose a concrete version). Enforced by inspection
(`grep -r 'platform/' src/generator` is empty) and pinned by
B2.1's regression test. Why it matters: the shared core stays
usable by *any* backend version (so `hono@v5` just passes different
pins), and it keeps open a future packaging split where a consumer
installs only the backend they target — a `shared → package` edge
would foreclose both. The Loom IR + lowering + enrichment upstream
of the emitter are likewise always shared and never per-package.

### When to cut a new version vs bump in place

- **New package version**: an upstream **major** that changes
  generator *logic* (MediatR 2→14, Hono 4→5, Phoenix scaffold
  conventions, .NET minimal-API).
- **In-place** (already the policy, done for Hono in Phase 2.a):
  within-major / within-0.x dep bumps via the per-package
  `BACKEND_PINS` const. No new package, no DSL churn.

## Relationship to frontend stacks

They do **not** unify. A frontend *stack* (`stacks/vN`) is a
cross-cutting dep/bundler baseline shared by *all* design packs
(React/router/zod). A backend *package version* **is the generator
itself**. Same DSL *shape* (`family@version`, bareword → latest,
pin to opt out), different *substance* (data axis vs code module).
`web/src/bundle/stacks.ts` bundler hints are React-frontend-only and
never apply to backends (no in-browser bundling of backends).

## Migration path (incremental, each step byte-identical until the last)

| Phase | Scope | Risk gate |
| --- | --- | --- |
| **B0** ✅ | Registry generalisation: family@version keying + `BUILTIN_PLATFORM_LATEST`, single versions registered. Bareword resolves to the sole version. **Byte-identical.** (PR #175) | `npm test` 888 + baseline fixture clean |
| **B1** ✅ | Grammar `Platform \| STRING` + validator/lower qualify. `platform: "node@v4"` pins; bareword unchanged. **Byte-identical.** (branch `claude/backend-pkg-b1-grammar`) | `npm test` 896 + parsing/validation tests + fixture clean |
| **B2** ✅ | `hono@v4` becomes a versioned package: `src/platform/hono/v4/{index.ts,pins.ts}`, registry points at it, `BACKEND_PINS` ownership moved into the package. The bulk emitter stays shared under `src/generator/typescript/` — a future `hono@v5` forks only what changes, by ordinary import. **Byte-identical.** (branch `claude/backend-pkg-b2-hono-package`) | fixture clean + `LOOM_TS_BUILD` 3/3 |
| **B2.1** ✅ | **Layering fix.** B2 left a shared→package edge (the shared emitter `import`ed v4's `BACKEND_PINS`), which would block `hono@v5` and any future per-backend packaging split. Inverted: the shared emitter takes `pins: BackendPins` as a parameter; the package's surface (and the CLI/test entrypoints) supply it. **Zero `src/generator/ → src/platform/` edges.** Byte-identical. (branch `claude/backend-pkg-b2.1-pins-inversion`) | fixture clean + `LOOM_TS_BUILD` 3/3 + grep-asserted no reverse edge |
| **B3** | First real new major: `hono@v5` as a separate package reusing v4's stable slices, passing its own pins to the (now version-agnostic) shared emitter. Bareword stays v4; opt-in via pin. | new `LOOM_TS_BUILD` shard for `@v5`; promote later |
| **B4+** | `dotnet@v10` (post-2026-11 LTS), `phoenix@v2` (already 1.8 — fold the existing in-place bump into the package boundary). | per-backend build gate |

B0–B2 are pure machinery (the Phase-0 discipline that worked for
packs/stacks: land the seam with zero output change, prove it, then
introduce new versions). The architecture decision to commit to now
is **B0+B1's shape**; B3+ are independent follow-ups.

## Open questions (decide before B3)

1. **`render-expr`/`render-stmt` sharing granularity.** How much of
   a backend's final-lowering is stable across its majors? If most
   of it is (likely — domain-expression lowering rarely changes
   with a framework major), the new package imports it wholesale
   and overrides only project/DI/middleware emission. Audit when
   cutting the first real `@v5`.
2. **`static`/`react` in the family@version scheme.** Frontends
   already version via `design:`/stack; `platform: react` should
   stay bareword-only (its versioning lives on the pack/stack axis).
   The registry generalisation must treat frontend platforms as
   single-version and not force a `react@vN`.
3. **CI sharding.** `LOOM_TS_BUILD` / `LOOM_PHOENIX_BUILD` grow a
   version dimension (like `LOOM_REACT_BUILD_CASE=<ddd>:<family>@<v>`
   did for packs). .NET still has no automated build gate — B4
   needs a `dotnet build` shard first.

## Recommendation

Adopt the model. Implement **B0 + B1** as the committing slice
(byte-identical machinery; the registry + grammar + lower changes
mirror the battle-tested `design:` path). Defer B2+ — restructuring
a backend into the 3-slice package and the first real `@v5` are
separate, independently-gated PRs, sequenced when an upstream major
actually forces the change (Hono 5 / .NET 10 timing).

## Sequel: distribution

B0–B2.1 make backends versioned packages **in-tree**. Shipping them
as separately-installable npm packages discovered via a manifest is
designed in [`packaging-split.md`](./packaging-split.md) — it
depends on, and validates, the `package → shared` layering
invariant B2.1 established.
