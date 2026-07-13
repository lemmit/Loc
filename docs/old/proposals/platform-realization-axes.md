# Platform realization axes — naming review + the gating matrix

> Status: **PINNED** as **D-REALIZATION-AXES** (`docs/decisions.md`). Builds on
> **D-ADAPTER-HOME**, **D-PHOENIX-SURFACE**, **D-STORAGE-SPLIT**. It (a) reviews
> the existing knob names, (b) adds the axes the current design leaves homeless,
> (c) consolidates the cross-axis **gating matrix** with validator codes, and
> (d) gives worked `.ddd` examples (§11) and a grammar sketch (§12).
>
> **It amends D-PHOENIX-SURFACE** on one point — see §0.1 and §9: the
> domain-framework axis gets its own keyword, `foundation:`, rather than being
> folded into `persistence:`.

> **[2026-07-12 status refresh — CONVERGED to two axes; supersedes the 2026-06-20 audit below.]** Four of the six axes were removed as inert/theater: **`foundation:`** (grammar clause + `DeployableIR.foundation` + R4/R6 deleted), **`application:`/style** (one fixed emission style per backend, kept only as an internal `StyleAdapter` — no longer user-selectable), and **`transport:` / `runtime:`** (name-only registries no emitter read — deleted whole, `resolveTransport`/`resolveRuntime` gone). Every reserved *stub* adapter was removed too. The grammar now parses only **`persistence:`** and **`directoryLayout:`** (`ddd.langium:203-204`; validator `RealizationAxis = "persistence" | "directoryLayout"`). `directoryLayout` is fully adapter-consumed (`layout.pathFor`); `persistence` is real but selected by a raw `deployable.persistence` key-branch (`resolvePersistence()` uninvoked). The gating matrix, rung table, and R2–R7 rules below target the retired six-axis design — historical. Canonical: the D-REALIZATION-AXES supersession block in `docs/decisions.md`.

> **[2026-06-20 status audit]** *(superseded by the 2026-07-12 note above — the six-axis framing here is stale.)* Beyond 'pinned' — the six-axis `platform { … }` block has SHIPPED across grammar (`ddd.langium:~180`), IR (`loom-ir.ts:~2226`), validator R1/R3/R4/R6 (`deployable.ts:~317`), and generators (`elixir/index.ts`, `java/adapters/by-layer-layout.ts`). Only R2/R7 + the node-actor `runtime:` menu remain; the IR comment 'no generator consumes them yet' is also stale.

> **(Superseded 2026: the Ash foundation was removed; `platform: elixir` is plain Ecto/Phoenix only; `foundation: ash` is now a validation error.)** The `foundation:` knob still exists, but on phoenix/elixir it resolves to `vanilla` only — `vanilla` is the default and the sole valid value, and `ash` (plus the `ashPostgres`/`ashSqlite` persistence flavors) is rejected. The Ash prose below is retained as design history; read the phoenix rows/examples through this correction.

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
| `phoenix` | `vanilla`* (fixed — `ash` removed) | `serviceLayer`* · `flat` · `cqrs` | `ecto`* | `byFeature`* · `byLayer` | `phoenixRouter`* (fixed) | `transactional`* · `genserver` |

`*` = default. `phoenix` defaults to `foundation: vanilla` — plain Ecto/Phoenix.
(The Ash foundation was removed in 2026; `foundation: ash` and the
`ashPostgres`/`ashSqlite` flavors are now validation errors. The original row read
`ash`* · `vanilla` with `ashPostgres`*/`ashSqlite` as the default persistence —
kept here only as design history.)

## 7. Cross-axis gating rules + validator codes

Codes follow the `loom.<kebab>` convention (cf. `loom.bare-aggregate-in-type`).
R1–R3 are from the storage doc (§574–578); R4–R7 are added here.

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
- **Pinned and AMENDED (recorded as D-REALIZATION-AXES):** D-PHOENIX-SURFACE's
  *mechanism* for the domain axis ("rides `persistence:`/`style:`, no new
  keyword") is superseded — the axis gets the dedicated keyword **`foundation:`**
  (default `vanilla`) so the data layer stays pickable under a framework (§0.1).
  D-PHOENIX-SURFACE open-item 1 (`style:` vs `persistence:` for Ash/Ecto) is
  thereby **resolved** — it's neither; it's `foundation:`. Every other
  D-PHOENIX-SURFACE conclusion stands.
- **Pinned by D-REALIZATION-AXES:** the six-axis vocabulary and defaults; the
  `style:`→`application:` and `layout:`→`directoryLayout:` renames; the
  `application: flat` value; `transport:`; `runtime:` (default `transactional`);
  rules R4–R7; the per-platform menu in §6.

## 10. Open questions

1. **`node`/`hono` actor story** — `transactional`-only for v1; no real consumer
   for a worker/XState actor option yet ("consolidate the present",
   D-ADAPTER-HOME).
2. **`abp` / `nestjs` menus** — listed as the rung-3/4 exemplars; their exact
   sub-menus (what each owns vs leaves open) firm up when a real consumer lands.

## 11. Worked examples

All examples assume the `storage`/`dataSource` decls from D-STORAGE-SPLIT exist.
The realization knobs live in the `platform: <name> { … }` block on a
`deployable`.

**1 — Bare platform (the 99% path).** No knob written; every axis takes its
default. Byte-identical to today's output.

```ddd
deployable api {
  contexts: [Orders]
  platform: dotnet            # ≡ { foundation: vanilla, application: cqrs,
                              #     persistence: efcore, directoryLayout: byLayer,
                              #     transport: minimalApi, runtime: transactional }
}
```

**2 — Simplest possible app.** Flat handlers straight to EF Core, controllers,
one folder per feature.

```ddd
deployable api {
  contexts: [Catalog]
  platform: dotnet {
    application:     flat
    transport:       controllers
    directoryLayout: byFeature
  }
}
```

**3 — Dapper instead of EF, classic service layer.**

```ddd
deployable api {
  contexts: [Billing]
  platform: dotnet {
    application: serviceLayer
    persistence: dapper
  }
}
```

**4 — Actor-hosted aggregates (Orleans grains over EF, state-stored).** Legal:
`runtime: orleans` + non-journal `persistence:` is the valid non-ES mode (R5).

```ddd
deployable api {
  contexts: [Orders]
  platform: dotnet {
    application: cqrs
    runtime:     orleans
    persistence: efcore        # grain state persisted via EF; not event-sourced
  }
}
```

**5 — Akka.NET persistent actors with event sourcing (idiomatic).** `marten`
supplies the event journal; the `Order` aggregate is `eventSourced`.

```ddd
aggregate Order { persistenceStrategy: eventSourced /* … */ }

deployable api {
  contexts: [Orders]
  platform: dotnet {
    application: cqrs           # only cqrs may event-source (R3)
    runtime:     akka
    persistence: marten
  }
}
```

**6 — Opinionated framework (`foundation: abp`).** ABP owns `application:` and
`transport:`; setting them is an error (R4). The data layer underneath stays
pickable.

```ddd
deployable api {
  contexts: [Hr]
  platform: dotnet {
    foundation:  abp
    persistence: efcore         # the data layer ABP rides — still your choice
    # application:/transport: would be loom.platform-knob-owned-by-foundation
  }
}
```

**7 — Phoenix, plain Ecto (non-Ash).** `foundation: vanilla` opens the
application axis; it is now the default *and only* `foundation` on `platform:
phoenix` (the Ash default was removed in 2026 — `foundation: ash` is a validation
error).

```ddd
deployable web {
  contexts: [Orders]
  platform: phoenix {
    foundation:  vanilla        # plain Phoenix contexts + Ecto (not Ash)
    application: serviceLayer    # Phoenix context modules
    persistence: ecto
  }
  hosts: [OrdersUi]             # LiveView UI (framework on the `ui` decl)
}
```

**8 — Phoenix, Ash on SQLite.** *(Superseded 2026: the Ash foundation was
removed; this combination is no longer valid — `foundation: ash` and
`persistence: ashSqlite` are validation errors. Retained as design history of
what the two-axis split was meant to express.)* The combination the old "fold
into `persistence:`" mechanism could not express — `foundation:` keeps the data
layer pickable.

```ddd
deployable web {
  contexts: [Orders]
  platform: phoenix {
    foundation:  ash
    persistence: ashSqlite      # Ash's data layer flavor
    # application:/transport: owned by Ash (R4)
  }
}
```

**Diagnostics these would raise:**

```ddd
platform: phoenix { runtime: orleans }            # loom.platform-knob-out-of-menu
platform: dotnet  { foundation: abp, application: cqrs }  # loom.platform-knob-owned-by-foundation
platform: dotnet  { application: serviceLayer }   # + eventSourced aggg → loom.platform-application-cannot-event-source
platform: dotnet  { application: flat, runtime: akka }    # warning: loom.platform-flat-with-actor-runtime
```

## 12. Grammar sketch

A non-normative shape for the `platform:` block, following the repo's grammar
conventions (discriminator-free flat optional clauses, `LooseName` for values so
the menu is enforced by the validator, not the parser — same pattern as
`design:`/`auth:` on `Deployable`). Replaces the bare `platform=Platform` clause
in the `Deployable` rule:

```langium
DeployablePlatform:
    'platform' ':' family=Platform ('{'
        ('foundation'      ':' foundation=LooseName ','?)?
        ('application'     ':' application=LooseName ','?)?
        ('persistence'     ':' persistence=LooseName ','?)?
        ('directoryLayout' ':' directoryLayout=LooseName ','?)?
        ('transport'       ':' transport=LooseName ','?)?
        ('runtime'         ':' runtime=LooseName ','?)?
    '}')?;
```

- `family=Platform` reuses the existing `Platform` enum (`dotnet`/`hono`/
  `phoenix`/`react`/`static` + `STRING` pins).
- Each axis is an optional `LooseName`; `checkDeployable` validates the value
  against the platform's menu (R1) and runs the cross-axis rules (R2–R7).
- The block is itself optional — `platform: dotnet` with no `{ … }` is the
  all-defaults form (example 1).

**IR.** `DeployableIR` gains `foundation?`, `application?`, `persistence?`,
`directoryLayout?`, `transport?`, `runtime?` (optional pre-normalization). The
enrichment pass normalizes each to the platform default, so downstream phases see
concrete values (mirrors how `design?` is defaulted via `BUILTIN_PACK_LATEST`).

## Related

- `docs/decisions.md` — **D-REALIZATION-AXES** (this proposal, pinned),
  D-ADAPTER-HOME, D-PHOENIX-SURFACE, D-STORAGE-SPLIT.
- `docs/old/proposals/storage-and-platform-config.md` — the adapter surface and the
  original `style:`/`layout:`/`persistence:` menus (renamed per D-REALIZATION-AXES).
- `docs/old/proposals/elixir-ecto-and-api-only-backends.md` — the Ash/Ecto axis; its
  Phase 2 is now answered by `foundation:` rather than a `persistence:`/`style:`
  field choice.
