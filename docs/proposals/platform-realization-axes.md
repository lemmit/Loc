# Platform realization axes — naming review + the gating matrix

> Status: **proposal**. Builds on `storage-and-platform-config.md` and the
> pinned decisions **D-ADAPTER-HOME**, **D-PHOENIX-SURFACE**, **D-STORAGE-SPLIT**
> (`docs/decisions.md`). Nothing here contradicts a pin; it (a) reviews the
> existing knob names, (b) adds two axes the pins leave homeless, and (c)
> consolidates the cross-axis **gating matrix** with validator codes.

## 0. The question this answers

`platform: dotnet` today bundles EF Core + MediatR-CQRS + minimal API + xUnit
with no exposed knobs (`storage-and-platform-config.md:58`). The plan is to
decompose that bundle into orthogonal, optional, validator-gated config — the
`platform: <name> { … }` block. Most of that decomposition is already designed
as the **D-ADAPTER-HOME** adapter surface (`style:` / `layout:` / `persistence:`,
each a menu+default exposed off the backend's `PlatformSurface`). This note
closes the two remaining gaps:

- the **API-surface** axis (minimal API vs controllers), orphaned when
  D-PHOENIX-SURFACE retired backend `framework:`;
- the **aggregate-runtime** axis (Orleans / Akka.NET / GenServer actors), which
  no existing axis covers.

## 1. The one-concern-per-knob principle

A backend turns the *same* platform-neutral IR into source. Each knob picks how
**one layer** is realized; they compose freely. Keep them orthogonal — a single
"app layer" knob would force a combinatorial value explosion
(`cqrs-actors-dapper-minimal`…). The full set:

| Axis (knob) | Layer it realizes | Status |
|---|---|---|
| `platform:` | host runtime / web framework (the family) | shipping |
| `style:` | application architecture (command/query shape) | designed (storage doc) |
| `persistence:` | domain + data framework (the ORM / resource framework) | designed; **absorbs the Ash/Ecto axis per D-PHOENIX-SURFACE** |
| `layout:` | file / project organization | designed (storage doc) |
| **`transport:`** | HTTP surface (endpoint style) | **new here** (rehomes orphaned backend `framework:`) |
| **`runtime:`** | aggregate execution / concurrency model | **new here** |

The domain is the `.ddd` source — the invariant every axis orbits. There is no
`domain:` knob; "Ash vs Ecto" is a `persistence:` value, not a domain variant
(D-PHOENIX-SURFACE: *"No `domain:` keyword, and nothing Phoenix-only."*).

## 2. Naming review of the existing knobs

| Knob | Verdict | Notes |
|---|---|---|
| `style:` | **keep** | Good name for the architectural pattern: `cqrs` \| `layered`. This *is* "CQRS vs service layer" — already designed, no new knob needed. |
| `layout:` | **keep** | `byLayer` \| `byFeature`. Clear, orthogonal, well-scoped. |
| `persistence:` | **keep** — and prefer it over "dal" | "DAL" is a dated, ambiguous acronym; `persistence:` is the established term and already carries `efcore`/`dapper`/`marten`. Per D-PHOENIX-SURFACE it also carries `ash`/`ecto`. So your "dal" *and* my earlier "foundation" both collapse into `persistence:`. |
| `framework:` (backend) | **retire** (already pinned) | D-PHOENIX-SURFACE freed `framework:` to the **UI** axis (`ui { framework: react \| liveview }`) and ruled out a second backend `framework:`. The "minimal API vs controllers" axis it used to carry is rehomed below as `transport:`. |

So three of the four names you have are good and stay; only backend `framework:`
needed to move — and the pins already moved it. The Ash-vs-Ecto choice you asked
about is **not a new knob**: it is a `persistence:` value on `phoenix`
(`persistence: ash` default, `persistence: ecto` for plain Phoenix contexts).

## 3. New knob #1 — `transport:` (the API surface)

The "minimal APIs vs full ASP.NET controllers" axis. `framework:` can't host it
(now UI-only) and `api:` collides with the `api` declaration keyword. Recommended
name: **`transport:`** (the HTTP surface the backend exposes). Alternatives
considered: `endpoints:` (fine), `http:` (too low-level), `apiStyle:` (verbose).

```
transport:  minimalApi (default) | controllers      # dotnet
            hono (default, fixed)                    # node/hono
            phoenixRouter (default, fixed)           # phoenix
```

On platforms with a single legal value the author never writes it (same
size-1-menu rule the pins use for `persistence: hono`).

## 4. New knob #2 — `runtime:` (the actor / aggregate-execution axis)

**This is the knob your question opened with.** What unifies Orleans grains,
Akka.NET persistent actors, and Phoenix GenServers-per-aggregate is *how the
aggregate is hosted and executed at runtime* — a long-lived, single-threaded-
per-entity, message-driven process, versus a stateless object rehydrated from
the repository per request. That is a **runtime / concurrency** choice, distinct
from `style:` (a read/write *shape*) and `persistence:` (the data framework).

Recommended name: **`runtime:`**. Alternatives: `concurrency:` (most precise —
the actor model is fundamentally a concurrency+consistency model; slightly
academic), `hosting:` (leans toward deployment). Avoid `actors:`/`actorModel:`
(bakes the answer into the question — bad when one value is "no actors") and
`model:` (hopelessly overloaded in a DDD tool).

```
runtime:  pooled (default) | orleans | akka          # dotnet
          pooled (default) | genserver               # phoenix
          pooled (default, fixed)                     # node/hono
```

**Value naming.** Name the default after what the standard impl *is*, not
"not-actors". `pooled` = the aggregate is reconstituted on demand from the
repository and concurrency is handled by the DB (transactions / optimistic
concurrency). (`transactional` is an equally good default name if you prefer to
foreground the consistency model; pick one and use it everywhere.) The actor
values name the concrete realization and are gated per family — exactly the
`design: mantine` precedent. Like `design:`, `runtime:` is **optional**, and
lowering normalizes absence → `pooled` so backends `switch` on a concrete value
rather than `undefined`.

## 5. Per-platform menus (the gating matrix)

Each backend's `PlatformSurface` exposes its menu + default (D-ADAPTER-HOME). A
**bare** `platform: <name>` equals the full default block — byte-identical to
today's output (`storage-and-platform-config.md:881`).

| Platform | `style:` | `persistence:` | `layout:` | `transport:` | `runtime:` |
|---|---|---|---|---|---|
| `dotnet` | `cqrs`* · `layered` | `efcore`* · `dapper` · `marten` | `byLayer`* · `byFeature` | `minimalApi`* · `controllers` | `pooled`* · `orleans` · `akka` |
| `node` (hono) | `cqrs`* · `layered` | `drizzle`* (+1 ES-capable, TBD) | `byLayer`* · `byFeature` | `hono`* (fixed) | `pooled`* (fixed) |
| `phoenix` | `layered`* (Ecto only — see §6) | `ash`* · `ecto` | `byFeature`* · `byLayer` | `phoenixRouter`* (fixed) | `pooled`* · `genserver` |

`*` = default. `phoenix` defaults to `persistence: ash` per D-PHOENIX-SURFACE
open-item 2 (PINNED).

## 6. Cross-axis gating rules + validator codes

Validation codes follow the `loom.<kebab>` convention (cf.
`loom.bare-aggregate-in-type`). Rules R1–R3 are already in the storage doc
(§574–578); R4–R6 are added here for the new axes and the framework-lock insight.

**R1 — out-of-menu.** Any knob value not in the platform's menu → **error**.
`loom.platform-knob-out-of-menu`
> `runtime: orleans` is not available on platform `phoenix`. Available: `pooled`, `genserver`.

**R2 — layout meaningless for layered.** `layout: byFeature` × `style: layered`
→ **warning**, treated as `byLayer`. `loom.platform-layout-meaningless-for-style`
> `layout: byFeature` has no effect with `style: layered` (one artifact set per aggregate, not per feature). Ignoring; using `byLayer`.

**R3 — layered can't event-source.** `style: layered` × any contained aggregate
with `persistenceStrategy: eventSourced` → **error**.
`loom.platform-layered-with-event-sourcing`
> `style: layered` has no command/event flow for the event-sourced aggregate `Orders.Order`. Use `style: cqrs`.

**R4 — owning-framework lock (the "foundation" insight).** Some `persistence:`
values are *opinionated frameworks* that own the application + transport layers
(Ash owns resources+actions+API; a future `abp` would own app-services+API).
When such a value is chosen, the knobs it owns must not also be set → **error**.
`loom.platform-knob-owned-by-framework`
> `persistence: ash` owns the application architecture and API surface. Remove `style:` / `transport:` (Ash supplies them).

This is why `persistence:` and `style:`/`transport:` coexist *and* sometimes
conflict: a rung-1/2 persistence (`dapper`, `ecto`, `drizzle`) leaves the other
knobs open; a rung-4 framework (`ash`) locks them. Each surface declares, per
value, which axes it owns — the validator reads that off the menu.

**R5 — actor runtime needs a compatible store.** State-persisting actor runtimes
need a journal/grain-store. `runtime: akka` (persistent actors) requires an
ES-capable `persistence:` (`marten`, or an event-journal adapter); `runtime:
orleans` requires a configured grain-storage provider. Incompatible pair →
**error**. `loom.platform-runtime-persistence-incompatible`
> `runtime: akka` needs an event-journal-capable persistence. `persistence: dapper` provides none. Use `persistence: marten` or an event-store adapter.

**R6 — runtime ⟂ style is allowed.** `runtime:` and `style:` are independent
(`cqrs + orleans`, `layered + genserver` are all legal). No rule needed — noted
so nobody adds a spurious one.

## 7. Defaults, normalization, round-trip

- Every realization knob is **optional**. The common path writes none.
- Lowering normalizes each omitted knob to the platform default, so the IR field
  is always a concrete value (`runtime: "pooled"`, `style: "cqrs"`, …) — codegen
  dispatches on a value, error messages enumerate a vocabulary, and `ddd
  snapshot` / the unfold-macro printer round-trip the normalized form. (Same
  treatment `design:` already gets via `BUILTIN_PACK_LATEST`.)
- IR shape: extend `DeployableIR` with `style?`, `layout?`, `persistence?`,
  `transport?`, `runtime?` (pre-normalization optional; post-normalization the
  enriched model carries concrete values), mirroring how `design?` is handled.

## 8. What's pinned vs proposed

- **Pinned (do not relitigate):** the adapter surface and its home
  (D-ADAPTER-HOME); Ash/Ecto rides `persistence:`/`style:`, no `domain:` keyword,
  one `phoenix` platform, `framework:` is UI-only, default `persistence: ash`
  (D-PHOENIX-SURFACE); `storage`/`dataSource`/`deployable` split (D-STORAGE-SPLIT).
- **Proposed here:** the name `transport:` for the rehomed API-surface axis; the
  name `runtime:` (default `pooled`) for the actor axis; rules R4–R6 and their
  codes; the consolidated per-platform menu in §5.

## 9. Open questions

1. **`persistence:` vs `style:` for the Ash/Ecto field** — D-PHOENIX-SURFACE
   open-item 1 leaves this to the Ecto note's Phase 2. This proposal recommends
   **`persistence:`** (Ash is a data+domain framework, sibling to `marten`),
   which keeps `style:` meaning exactly one thing universally (`cqrs`|`layered`)
   and lets R4 express the framework-lock cleanly. If `style:` is chosen instead,
   R4 moves to the `style:` surface unchanged.
2. **`pooled` vs `transactional`** as the `runtime:` default name — pick one
   project-wide. `pooled` foregrounds "reconstituted from the repo";
   `transactional` foregrounds the consistency model.
3. **`node`/`hono` actor story** — left `pooled`-only for v1; an XState/worker
   actor option is conceivable but has no real consumer yet ("consolidate the
   present, don't design for the future", D-ADAPTER-HOME).

## Related

- `docs/proposals/storage-and-platform-config.md` — the adapter surface, the
  `style:`/`layout:`/`persistence:` menus, the v1 adapter list.
- `docs/proposals/elixir-ecto-and-api-only-backends.md` — the Ash/Ecto axis this
  builds on; its Phase 2 picks the §9.1 field.
- `docs/decisions.md` — D-ADAPTER-HOME, D-PHOENIX-SURFACE, D-STORAGE-SPLIT.
