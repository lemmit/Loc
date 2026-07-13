# NestJS backend — a structured-TS foundation (`foundation: nest` on `node`)

> Status: **PROPOSED (candidate — ranked ahead of `php-backend.md`).**
> The structured/enterprise TypeScript backend, complementing the
> prioritised Angular frontend. Two facts make it cheap: it **reuses the
> existing TS domain emission** (the `render-expr`/`render-stmt` that serve
> Hono), and it is **not a new platform** — it is a new **`foundation:`**
> on the existing `node` platform, the Node analogue of Elixir's
> `ash` vs `vanilla` split. Builds on
> [`platform-realization-axes.md`](./platform-realization-axes.md) and
> [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) (the
> foundation-axis precedent). Sibling of [`go-backend.md`](./go-backend.md)
> (new ecosystem / *reach*) — NestJS adds the enterprise tier of an
> ecosystem Loom already serves (*depth*).
>
> **(Superseded 2026: the Ash foundation was removed.)** This proposal repeatedly cites Elixir's `ash` vs `vanilla` foundation split as the precedent for `foundation: nest`. That precedent now has only one valid Elixir value — `platform: elixir` resolves to `foundation: vanilla` (plain Ecto/Phoenix) and `foundation: ash` is a validation error. The `foundation:` knob and the "foundation branch inside one platform surface" mechanism still stand; read the Ash mentions below as the historical motivation, not a current second Elixir foundation.

## TL;DR

Add **NestJS** as **`foundation: nest` on `platform: node`** —
modules/controllers/providers/DI over Express (or Fastify), MikroORM (or
TypeORM) over Postgres, optionally `@nestjs/cqrs` for the
command/query/event bus. It reuses the platform-neutral `EnrichedLoomModel`
*and* most of the existing TypeScript generator: no new IR, no new
language renderer, **no new platform**.

The two decisive facts:

1. **The TypeScript expression/statement renderers already exist.** Hono's
   `TS_TARGET` (the leaf table for the shared `ExprTarget`) and its
   `render-stmt.ts` render domain logic to TypeScript today. NestJS
   executes **the same TypeScript domain logic** — only the *framework
   shell* (DI modules, decorator controllers, providers, bootstrap)
   differs.
2. **NestJS is a foundation, not a platform or a transport.** It is to
   Node what **Ash is to Elixir** — an opinionated structural skeleton
   that itself runs *on top of* a lower transport (Express/Fastify) and
   cascades opinions into the other axes. It slots into the `node`
   platform exactly as `foundation: vanilla` slots into `elixir`.

**Effort: ~3–5 engineer-weeks** for Hono-parity, or **~1.5–2.5 weeks** for
a walking skeleton — roughly **half a new-language backend**, because the
expensive half (name-resolved expression/statement rendering) is inherited
verbatim and only one axis value is genuinely new.

## Why NestJS is a `foundation`, not a `transport`

An earlier draft modelled NestJS as `transport: nest`. That is wrong, and
the realization-axes machinery says why. The six axes (D-REALIZATION-AXES,
`ddd.langium:112-129`) are orthogonal:

`platform` · `foundation` · `application`(style) · `persistence` ·
`directoryLayout` · `transport` · `runtime`

`transport:` is **only the HTTP surface** (`hono`/`express`/`fastify`/
`minimalApi`/`controllers`/`phoenix`). NestJS is **not** an HTTP surface —
it *sits on top of one* (it runs on Express or Fastify) and adds a DI
container, a module system, and structural opinions. That is the
definition of a **foundation**, and the codebase already has the exact
precedent on Elixir:

| | Opinionated structural foundation | Minimal foundation |
|---|---|---|
| **Elixir** | `foundation: ash` (Ash resources/DI/actions) | `foundation: vanilla` (plain Ecto/Phoenix) |
| **Node** | **`foundation: nest`** (Nest modules/DI/decorators) | today's Hono setup (the implicit minimal foundation) |

Like `foundation: vanilla` on Elixir (which overrides persistence/style/
transport defaults via `foundationAdapterOverride`, `elixir.ts:90-100`),
`foundation: nest` **cascades defaults into the other axes**. That cascade
is the whole answer to "what are the knobs."

## All the knobs, resolved for `foundation: nest`

| Axis (grammar name) | NestJS value(s) | Default under `nest` | Reuse vs new |
|---|---|---|---|
| **`platform`** | `node` | `node` | **Reuse** — same platform as Hono, *not* a new one |
| **`foundation`** | **`nest`** (new) | `nest` | **New** — the one genuinely new axis value (the module/DI/decorator skeleton) |
| **`transport`** | `express` / `fastify` | `express` | **Mostly free** — `express`/`fastify` already exist as node transport stubs (`hono/v4` menu); promote `express` to real under nest. `foundation: nest, transport: fastify` cleanly expresses "Nest over Fastify" |
| **`application`** (style) | `layered` / `cqrs` | `layered` | `layered` reuses Hono's; **`cqrs` is the differentiator** — `@nestjs/cqrs` ships a real command/query/event bus (the MediatR / Symfony-Messenger analog), so cqrs is a *cheap real* fast-follow, not the stub it is on Hono |
| **`persistence`** | **`mikroorm`** / `typeorm` / `drizzle` | `mikroorm` (skeleton) → `typeorm` (idiom) | **`mikroorm` is REUSE** — node already ships a real `mikroorm` adapter (F6b). Lead the skeleton with it to ship cheaper *and inherit its `loom.mikroorm-unsupported` gate for free*; add `typeorm` (the more idiomatic Nest default) next |
| **`directoryLayout`** | `byFeature` / `byLayer` | **`byFeature`** | **Reuse** — both already real on node. Nest's CLI idiom is module-per-feature → `byFeature` default (matches Elixir; contrasts Hono's `byLayer`) |
| **`runtime`** | `transactional` / `worker` | `transactional` | `worker` is a node **stub** today — `@nestjs/bull` (BullMQ) makes Nest the natural place to make it **real first** |

Of seven knobs, **only `foundation: nest` is a new value.** `transport`
(express/fastify), `persistence` (mikroorm), `directoryLayout` (both), and
`application: layered` are reuse; and three existing stubs (`express`,
`worker`, `cqrs`) become real *cheaply, because Nest provides each
first-class*.

## Capability gates this implies

New persistence adapters always ship a minimal-v1 gate (cf.
`loom.dapper-unsupported` / `loom.mikroorm-unsupported`,
`system-checks.ts:420-546`). For NestJS:

- **Lead with `mikroorm` → inherit `loom.mikroorm-unsupported` for free.**
  When `typeorm` lands, add a parallel **`loom.typeorm-unsupported`** (no
  nested parts / associations / managed fields / provenanced / audit /
  capability filters in v1) until it matures.
- **Pin the provenance/audit asymmetry.** `loom.provenanced-backend-unsupported`
  and `loom.audited-backend-unsupported` (`:936`, `:975`) gate those
  features to **hono only — not the whole `node` platform.** So a `nest`
  foundation does **not** automatically inherit provenanced fields /
  audited operations; whether the Nest shell implements them or inherits
  the "non-hono" rejection is a deliberate decision to pin.
- **`loom.context-filter-unsupported`** (`:402`) is keyed to `node +
  elixir`; Nest, being `node`, inherits it as-is (no new work, but note it).

## What is reused vs genuinely new

Anchored to the TypeScript/Hono generator (`src/generator/typescript/`,
≈ 7.2k LOC / 28 files):

| Concern | Reuse from the TS/Hono generator | New for the `nest` foundation |
|---|---|---|
| **Expression rendering** (17 `ExprIR` arms) | **`TS_TARGET` verbatim** (shared `ExprTarget` in `_expr/target.ts`) | none |
| **Statement rendering** (9 `StmtIR` arms) | **`render-stmt.ts` verbatim** | none |
| ids / value-objects / enums / events / DTOs | **mostly verbatim** — plain TS, framework-neutral | thin decorator stamping |
| `wireShape` consumption | **verbatim** (same enriched IR) | none |
| `MigrationsIR` → migrations | **reuse** the TS migration shape / `sql-pg.ts` | MikroORM/TypeORM migration wrapper |
| Repositories | repository *logic* reusable; **`mikroorm` adapter reusable** | TypeORM `Repository<E>` providers (when added) |
| **HTTP surface** | — | **new**: `@Controller`/`@Get`/`@Post` decorator controllers |
| **DI / module wiring** | — | **new**: `@Module({controllers, providers})` graph |
| **Validation** | — | **new**: `class-validator` decorator DTOs |
| **Bootstrap** | — | **new**: `main.ts` + `AppModule` + `NestFactory.create` |
| **CQRS** (optional) | — | **new**: `@nestjs/cqrs` bus wiring |

Genuinely-new surface = the **framework shell** (~3–4.5k LOC), against
Go's ~7k (Go pays for a new-language `render-expr`/`render-stmt` that the
`nest` foundation inherits).

## Generator home & `PlatformSurface` — a foundation branch, not a new surface

Following the Elixir foundation pattern (one `elixir.ts` surface serving
both `ash` and `vanilla`):

- **No new `PlatformSurface`.** Nest is a **foundation branch inside the
  `node` surface** — `emitProject` branches on `deployable.foundation ===
  "nest"`; `adapters()` / `adapterDefaults()` gain the nest foundation and
  its cascade. (`PlatformSurface` contract: `surface.ts:94-271` — `name`,
  `defaultPort`, `needsDb`, `mountsUi`, `hostableFrameworks`,
  `emitProject`, `composeService`, `adapters?`, `adapterDefaults?`.)
- **A `src/generator/typescript/nest/` subtree** — sibling of
  `src/generator/elixir/vanilla/` — holding the shell emitters
  (modules/controllers/providers/DI/bootstrap) and **importing the shared
  `render-expr`/`render-stmt`/DTO/id/VO emitters verbatim.** The reuse
  story made concrete: the new subtree is shell-only.
- **Foundation-driven cascade** in lowering — mirror
  `foundationAdapterOverride` so `foundation: nest` sets the
  transport/style/persistence/layout defaults from the knob table above.

## The fiddly parts

1. **DI graph correctness.** The new risk surface is the `@Module`
   provider/controller graph — every repository/service must be registered
   and injectable. Mechanical, but where a skeleton first goes wrong.
2. **Wire-shape conformance** — `conformance-parity.yml` per-PR gate, but
   *lower risk than a new-language backend*: it serializes the same TS DTOs
   Hono already gets right. Consume `agg.wireShape` directly.
3. **MikroORM-first vs TypeORM-first.** MikroORM is the cheaper first cut
   (real node adapter + gate already exist) but TypeORM is the more
   idiomatic Nest default. Lead MikroORM for the skeleton; add TypeORM as
   the idiomatic default before calling it parity.

## Tests & CI

Lighter than a new-language backend — it's the Node toolchain already in CI:

- `nest-build.yml` — `tsc --noEmit` + `nest build` (the `hono-build.yml`
  analog; same Node container).
- `nest-obs-e2e.yml` — boot the backend, assert the observability catalog
  envelope on stdout (the `hono-obs-e2e.yml` analog).

CI standup is **days, not the ~1 week a fresh language toolchain costs.**

## Phasing

1. **Skeleton (wk 1–1.5)** — `foundation: nest` wiring + cascade defaults +
   module/controller/provider/bootstrap for one aggregate, reusing TS
   expr/stmt rendering + the `mikroorm` adapter; `composeService` +
   Postgres; boot something.
2. **Parity (wk 1.5–3)** — full controller/repository/DTO/`class-validator`
   emit → pass `conformance-parity` and `nest-build`.
3. **Differentiators (wk 3–4.5)** — workflows, views, auth (Nest guards),
   observability e2e, **`@nestjs/cqrs` style promoted** (cheap), the
   **`typeorm` adapter + `loom.typeorm-unsupported` gate**, optionally
   **`worker` runtime real via `@nestjs/bull`**.
4. **Hardening (wk 4.5–5)** — `examples/*.ddd` coverage, docs rows in
   `platforms.md` / `generators.md`.

## Decisions to pin before starting

- `foundation: nest` (not `transport: nest`, not a new platform). **Pinned
  by the Ash/vanilla precedent.**
- MikroORM-first vs TypeORM-first default. **MikroORM-first skeleton**
  (reuse + free gate), **TypeORM the idiomatic default** added in phase 3.
- Express vs Fastify transport. **Express default** (Nest default; Fastify
  a flip).
- Promote `@nestjs/cqrs` in v1 or stub? **Stub v1, fast-follow** (cheap —
  the bus is first-class).
- Implement provenance/audit on the nest shell, or inherit the hono-only
  rejection? **Inherit the rejection in v1**; revisit if demand appears.

## Cross-references

- [`platform-realization-axes.md`](./platform-realization-axes.md) — the
  six axes; `nest` is a `foundation` value, the cascade-source for the rest.
- [`vanilla-phoenix-foundation.md`](./vanilla-phoenix-foundation.md) — the
  `foundation:` precedent (`ash` vs `vanilla`) the `nest` foundation copies.
- [`go-backend.md`](./go-backend.md) — the *reach* sibling (new ecosystem);
  NestJS is the *depth* sibling (cheap, reuses TS emission, no new platform).
- [`angular-frontend.md`](./angular-frontend.md) — the Angular pairing that
  makes NestJS the enterprise-TS full-stack completion.
- [`nextjs-frontend.md`](./nextjs-frontend.md) — the Next.js pairing: a
  `foundation: nest` backend owns the domain while Next is the frontend,
  and—being a node runtime—Nest can *host* Next's SSR in one process
  (`nest hosts: next`), the node twin of phoenix-embeds-React.
- [`render-expr-target-unification.md`](./render-expr-target-unification.md)
  — the `TS_TARGET` the `nest` foundation inherits **verbatim** (the saving).
- [`docs/platforms.md`](../../platforms.md) / [`docs/generators.md`](../../generators.md)
  — surface contract + per-backend feature matrix (add a Nest column).
