# Platform realization axes — naming review + the gating matrix

> Status: **proposal**. Builds on `storage-and-platform-config.md` and the
> pinned decisions **D-ADAPTER-HOME**, **D-PHOENIX-SURFACE**, **D-STORAGE-SPLIT**
> (`docs/decisions.md`). It (a) reviews the existing knob names, (b) adds the
> axes the current design leaves homeless, and (c) consolidates the cross-axis
> **gating matrix** with validator codes.
>
> **It also amends D-PHOENIX-SURFACE** on one point — see §0.1 and §8. The
> domain-framework axis gets its own keyword, `foundation:`, rather than being
> folded into `persistence:`.

## 0. The question this answers

`platform: dotnet` today bundles EF Core + MediatR-CQRS + minimal API + xUnit
with no exposed knobs (`storage-and-platform-config.md:58`). The plan is to
decompose that bundle into orthogonal, optional, validator-gated config — the
`platform: <name> { … }` block. Most of that decomposition is already designed
as the **D-ADAPTER-HOME** adapter surface (`style:` / `layout:` / `persistence:`).
This note closes the remaining gaps:

- the **domain-framework** axis (Ash vs plain Phoenix, ABP vs vanilla .NET) —
  given its own keyword `foundation:` (§0.1, §3);
- the **API-surface** axis (minimal API vs controllers), orphaned when
  D-PHOENIX-SURFACE retired backend `framework:` — rehomed as `transport:` (§4);
- the **aggregate-runtime** axis (Orleans / Akka.NET / GenServer actors) —
  named `runtime:` (§5).

### 0.1 The amendment: `foundation:` is its own axis, not a `persistence:` value

D-PHOENIX-SURFACE folds "Ash vs Ecto" into the `persistence:` surface, reasoning
that *every backend freezes a domain framework* (hono→Drizzle, dotnet→EF). That
conflates two different categories:

- **`persistence:`** — a *data-access library* (Drizzle, EF Core, Dapper, Ecto).
  It persists; it does not model the domain or own the application layer.
  (Rung 1–2.)
- **`foundation:`** — an *opinionated domain/application framework* (Ash, ABP,
  NestJS) that owns domain modelling + application + API, and then sits **on top
  of** a data layer. (Rung 3–4.) Default: **`vanilla`** — no domain-modelling
  framework; the raw platform plus libraries you pick on the other axes.

Folding them collapses expressiveness: `persistence: ash` cannot say *what Ash
persists to*. As two axes, `foundation: ash` + `persistence: ashSqlite` (or
`foundation: abp` + `persistence: dapper`) stays expressible — the data layer
remains pickable *underneath* the framework.

This keeps D-PHOENIX-SURFACE's correct instinct (no `domain:` keyword — the
domain is the `.ddd` input, not a knob) while fixing the conflation:
`foundation:` does not vary the domain, it varies *which framework hosts* it.
All other D-PHOENIX-SURFACE conclusions stand (one `phoenix` platform, no
`family@version`, no `apiOnly` platform, `framework:` is UI-only).

## 1. The one-concern-per-knob principle

A backend turns the *same* platform-neutral IR into source. Each knob picks how
**one layer** is realized; they compose freely. Keep them orthogonal — a single
"app layer" knob would force a combinatorial value explosion. The full set:

| Axis (knob) | Layer it realizes | Status |
|---|---|---|
| `platform:` | host runtime / web framework (the family) | shipping |
| **`foundation:`** | opinionated domain/app framework — or `vanilla` | **new here** |
| **`application:`** | application-layer structure — `flat` \| `serviceLayer` \| `cqrs`, a spectrum of *how much* structure | designed as `style:`; **renamed + `flat` added** here (§2) |
| `persistence:` | data-access library (the ORM / query layer) | designed; **narrowed to data layer only** (§2) |
| **`directoryLayout:`** | source-tree / file organization | designed as `layout:`; **renamed here** (§2) |
| **`transport:`** | HTTP surface (endpoint style) | **new here** |
| **`runtime:`** | aggregate execution / concurrency model | **new here** |

The knob-naming rule: **name the axis after the layer it realizes** —
`persistence:` (data), `transport:` (HTTP), `runtime:` (execution),
`application:` (the application layer). That rule is why `style:` → `application:`
and not `layering:` (see §2).

There is no `domain:` knob — the domain is the source. `foundation:` names the
*framework hosting* the domain, which is a realization choice.

## 2. Naming review of the existing knobs

| Knob | Verdict | Notes |
|---|---|---|
| `style:` → **`application:`** | **rename + extend** | "style" is too vague. The axis configures the **application layer** — so name it for that layer, matching `persistence:`/`transport:`/`runtime:`. **Not** `layering:`: that collides with the value `serviceLayer`/`layered` and miscasts `cqrs` (CQRS is command/query separation, not a layering scheme). Values are a spectrum of *how much* application structure: **`flat`** (no application layer — the handler talks straight to the store; simplest apps) → **`serviceLayer`** (a service layer between handler and repository; storage doc spelled this `layered`) → **`cqrs`** (command/query handlers; default, for output continuity). Locked when a `foundation:` owns it (§7 R4). |
| `layout:` → **`directoryLayout:`** | **rename** | Make it explicit — and it disambiguates from the **page-level `layout:`** (the UI layout-wrapper selector), a real collision. Values `byLayer` \| `byFeature`. (`sourceLayout:`/`fileLayout:` are equivalent.) |
| `persistence:` | **keep — but narrow it** | Data-access library only: `efcore`/`dapper`/`marten`/`drizzle`/`ecto`/`ashPostgres`/… **Not** the domain framework (that's `foundation:`). This is the §0.1 amendment: prefer it over "dal" (dated acronym), but it carries *only* the data layer. |
| `framework:` (backend) | **retire** (already pinned) | D-PHOENIX-SURFACE freed `framework:` to the **UI** axis. Its old "minimal API vs controllers" duty is rehomed as `transport:` (§4). |

So `persistence:` narrows and keeps its name; `style:`/`layout:` are renamed to
the layer-named, collision-free `application:`/`directoryLayout:`; the
domain-framework axis becomes `foundation:` rather than overloading `persistence:`.

**On `application: flat`.** Loom aggregates carry domain logic (operation bodies,
invariants). Under `flat` that logic renders *inline in the route/endpoint
handler* — mutate the entity, call `dbContext.SaveChanges()` / `Repo.update()`
directly — instead of in a service method (`serviceLayer`) or command handler
(`cqrs`). It is deliberately the least structure, for the simplest apps; it gets
unwieldy for rich aggregates, which is why it is opt-in and not the default.

**Why the value is `flat`, not `transactionScript`.** The three values vary by
*orchestration topology* — where the per-request logic lives: inline in the
handler (`flat`) → an application-service class (`serviceLayer`) → mediator
command/query handlers (`cqrs`). "Transaction Script" (Fowler PoEAA) is a
*different*, orthogonal dimension — *how* the per-request logic is organized (a
procedure per request) — and it cuts across all three: a `serviceLayer` built as
one method per operation is itself a set of transaction scripts ("layered
transaction scripts"); Fowler notes a Service Layer can be "operation scripts" or
a thin facade over a domain model. So `transactionScript` would label one point
on the axis with a term that spans the whole axis. `flat` names the topology it
actually picks out (the antonym of "layered").

**The orthogonal axis we deliberately don't expose.** Transaction-Script vs
Domain-Model (logic in procedures over anemic data vs. logic on rich entities) is
a real axis — but Loom is **domain-model by construction** (an operation body is
behavior on a rich aggregate), so every backend emits domain-model code and the
axis is pinned. An anemic/transaction-script *emission* mode, if ever wanted,
would be its own future axis — **not** a value of `application:`. Keeping them
separate is what avoids conflating "where orchestration lives" with "how domain
logic is organized."

## 3. New knob #1 — `foundation:` (the domain/app framework)

Names the opinionated framework that owns multiple layers — or `vanilla` for
none. A spectrum of *how much of the stack the framework owns*:

| Rung | Owns | Example values |
|---|---|---|
| `vanilla` (default) | nothing — you assemble it via the other knobs | — |
| app framework (rung 3) | `application:` + `transport:`; **persistence stays open** | `nestjs` (node) |
| metamodel framework (rung 4) | `application:` + `transport:` **+ the data-layer flavor** | `ash` (phoenix), `abp` (dotnet) |

`vanilla` was chosen deliberately: it reads as "raw platform, no domain-modelling
framework" ("vanilla ASP.NET", "vanilla Phoenix" are idiomatic) — clearer than
`none`/`plain`/`raw`. Like the other knobs, `foundation:` is **optional**;
lowering normalizes absence to the platform default.

**The deep payoff.** `foundation:` decides *what kind of artifact Loom emits*. A
`vanilla` foundation → Loom renders **imperative implementation** (Ecto schemas +
context functions, service methods) and `render-stmt.ts` does full work. A
rung-4 foundation → Loom emits **declarations** (Ash resources/actions/policies,
ABP entities + app-services) and hands the metamodel job to the framework's
runtime. This is why `foundation: ash` and `foundation: vanilla` need different
`render-expr`/`render-stmt` paths on Phoenix.

## 4. New knob #2 — `transport:` (the API surface)

The "minimal APIs vs full ASP.NET controllers" axis. `framework:` can't host it
(now UI-only) and `api:` collides with the `api` declaration keyword. Recommended
name: **`transport:`** (the HTTP surface the backend exposes).

```
transport:  minimalApi (default) | controllers      # dotnet
            hono (default, fixed)                    # node/hono
            phoenixRouter (default, fixed)           # phoenix
```

On platforms with a single legal value the author never writes it.

## 5. New knob #3 — `runtime:` (the actor / aggregate-execution axis)

What unifies Orleans grains, Akka.NET persistent actors, and Phoenix GenServers-
per-aggregate is *how the aggregate is hosted and executed at runtime* — a
long-lived, single-threaded-per-entity, message-driven process, versus a
stateless object rehydrated from the repository per request. That is a
**runtime / concurrency** choice, distinct from `application:` (a read/write
*shape*), `persistence:` (the data layer), and `foundation:` (the framework).

Recommended name: **`runtime:`** (alternatives: `concurrency:` — most precise;
`hosting:` — leans deployment). Avoid `actors:` (bakes the answer in) and
`model:` (overloaded).

```
runtime:  transactional (default) | orleans | akka   # dotnet
          transactional (default) | genserver        # phoenix
          transactional (default, fixed)             # node/hono
```

**Value naming.** Name the default after what the standard impl *is*, not
"not-actors". **`transactional`** = the aggregate is loaded per request and the
consistency model is the DB transaction (load → mutate → commit, with optimistic
concurrency). That contrast — DB-transaction consistency vs. actor mailbox
serialization — is the real axis, so `transactional` names it more precisely than
the earlier coinage `pooled` (which only evoked "reconstituted from a pool" and
carried object/connection-pool baggage). Optional; lowering normalizes absence →
`transactional`.

## 6. Per-platform menus (the gating matrix)

Each backend's `PlatformSurface` exposes its menu + default (D-ADAPTER-HOME). A
**bare** `platform: <name>` equals the full default block — byte-identical to
today's output (`storage-and-platform-config.md:881`).

| Platform | `foundation:` | `application:` | `persistence:` | `directoryLayout:` | `transport:` | `runtime:` |
|---|---|---|---|---|---|---|
| `dotnet` | `vanilla`* · `abp` | `cqrs`* · `serviceLayer` · `flat` | `efcore`* · `dapper` · `marten` | `byLayer`* · `byFeature` | `minimalApi`* · `controllers` | `transactional`* · `orleans` · `akka` |
| `node` (hono) | `vanilla`* · `nestjs` | `cqrs`* · `serviceLayer` · `flat` | `drizzle`* (+1 ES-capable, TBD) | `byLayer`* · `byFeature` | `hono`* (fixed) | `transactional`* (fixed) |
| `phoenix` | `ash`* · `vanilla` | `serviceLayer`* · `flat` · `cqrs` (vanilla only) | `ashPostgres`*/`ashSqlite` (ash) · `ecto` (vanilla) | `byFeature`* · `byLayer` | `phoenixRouter`* (fixed) | `transactional`* · `genserver` |

`*` = default. `phoenix` defaults to `foundation: ash` (matches today's
`phoenixLiveView` after desugar — D-PHOENIX-SURFACE open-item 2, PINNED, now
expressed on `foundation:` instead of `persistence:`).

## 7. Cross-axis gating rules + validator codes

Codes follow the `loom.<kebab>` convention (cf. `loom.bare-aggregate-in-type`).
R1–R3 are from the storage doc (§574–578); R4–R6 are added here.

**R1 — out-of-menu.** Any knob value not in the platform's menu → **error**.
`loom.platform-knob-out-of-menu`
> `runtime: orleans` is not available on platform `phoenix`. Available: `transactional`, `genserver`.

**R2 — directoryLayout meaningless without per-feature artifacts.**
`directoryLayout: byFeature` × `application: serviceLayer | flat` → **warning**,
treated as `byLayer` (these produce one artifact set per aggregate, or one file,
not multiple per-feature artifacts). `loom.platform-layout-meaningless-for-application`

**R3 — only `cqrs` can event-source.** `application: serviceLayer | flat` × any
contained aggregate with `persistenceStrategy: eventSourced` → **error** (no
command/event flow to map onto the event stream).
`loom.platform-application-cannot-event-source`

**R4 — foundation owns layers (the clean version).** Each `foundation:` value
declares which of `{application, transport, persistence-flavor}` it owns. Setting
an owned knob is an **error**; `foundation: vanilla` owns nothing.
`loom.platform-knob-owned-by-foundation`
> `foundation: ash` owns the application architecture and API surface. Remove `application:` / `transport:` (Ash supplies them).

This is exactly why the axes coexist *and* sometimes conflict, and it reads far
more cleanly as `foundation:` than as "some `persistence:` values secretly lock
other knobs": a `vanilla` foundation leaves `application`/`transport`/`persistence`
fully open; a rung-3 foundation (`nestjs`) locks `application`/`transport` but
leaves `persistence` open; a rung-4 foundation (`ash`/`abp`) also constrains the
`persistence` menu to its compatible data layers.

**R5 — actor runtime needs a durable store, not necessarily a journal.** Actor
runtimes persist state through the chosen `persistence:`. The *idiomatic* pairing
is event-sourced (Akka.NET **persistent actors** over an event journal, e.g.
`marten`; an Orleans **grain-storage** provider), but it is **not required**: a
stateful actor can save current state directly via the data layer in each
handler (e.g. Akka.NET + EF Core via a `DbContextFactory`). So only a
`persistence:` with no durable store at all (pure in-memory/cache) → **error**;
a non-journal store → **allowed**. `loom.platform-runtime-persistence-incompatible`

**R6 — runtime ⟂ application is mostly independent.** `runtime:` and
`application:` compose freely in general (`cqrs + orleans`, `serviceLayer +
genserver` all legal).

**R7 — `flat` × actor runtime is non-standard.** `application: flat` × `runtime:
orleans | akka | genserver` → **warning** (not error). The actor host already
supplies the per-message handler structure that `flat` forgoes, so the
idiomatic pairing is `serviceLayer`/`cqrs` + actor. Saving state directly inside
the actor handler (the EF-`DbContextFactory`-in-handler pattern) works but is off
the idiomatic path. `loom.platform-flat-with-actor-runtime`

## 8. Defaults, normalization, round-trip

- Every realization knob (`foundation`, `application`, `persistence`,
  `directoryLayout`, `transport`, `runtime`) is **optional**; the common path
  writes none.
- Lowering normalizes each omitted knob to the platform default, so the IR field
  is always a concrete value — codegen dispatches on a value, errors enumerate a
  vocabulary, and `ddd snapshot` / the unfold-macro printer round-trip the
  normalized form (same treatment `design:` gets via `BUILTIN_PACK_LATEST`).
- IR shape: extend `DeployableIR` with `foundation?`, `application?`,
  `persistence?`, `directoryLayout?`, `transport?`, `runtime?`, mirroring how
  `design?` is handled.

## 9. What's pinned vs proposed

- **Pinned and kept:** the adapter surface and its home (D-ADAPTER-HOME); one
  `phoenix` platform, no `family@version`, no `apiOnly`, `framework:` is UI-only,
  Phoenix defaults to Ash (D-PHOENIX-SURFACE); the
  `storage`/`dataSource`/`deployable` split (D-STORAGE-SPLIT).
- **Pinned and AMENDED — needs a decisions.md update:** D-PHOENIX-SURFACE's
  *mechanism* for the domain axis ("rides `persistence:`/`style:`, no new
  keyword"). This proposal gives it the dedicated keyword **`foundation:`**
  (default `vanilla`) so the data layer stays pickable under a framework (§0.1).
  D-PHOENIX-SURFACE open-item 1 (`style:` vs `persistence:` for Ash/Ecto) is
  thereby **resolved/retired** — it's neither; it's `foundation:`.
- **Proposed here:** `foundation:` (and `vanilla`); `application: flat` (the
  third, zero-structure value); `transport:` for the API surface; `runtime:`
  (default `transactional`) for the actor axis; rules R4–R7; the per-platform
  menu in §6.

## 10. Open questions

1. **`node`/`hono` actor story** — `transactional`-only for v1; no real consumer
   for a worker/XState actor option yet ("consolidate the present",
   D-ADAPTER-HOME).
2. **Decision record** — fold §0.1 into `docs/decisions.md` as an amendment to
   D-PHOENIX-SURFACE (or a new D-FOUNDATION-AXIS entry that supersedes its
   domain-axis mechanism). Pending owner sign-off.

## Related

- `docs/proposals/storage-and-platform-config.md` — the adapter surface and the
  `style:`/`layout:`/`persistence:` menus.
- `docs/proposals/elixir-ecto-and-api-only-backends.md` — the Ash/Ecto axis; its
  Phase 2 is now answered by `foundation:` rather than a `persistence:`/`style:`
  field choice.
- `docs/decisions.md` — D-ADAPTER-HOME, D-PHOENIX-SURFACE, D-STORAGE-SPLIT.
