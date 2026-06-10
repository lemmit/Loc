# NestJS backend — structured TS (`transport: nest` on `node`)

> Status: **PROPOSED (candidate — ranked ahead of `php-backend.md`).**
> The structured/enterprise TypeScript backend, complementing the
> prioritised Angular frontend. Unlike a new-language backend, it **reuses
> the existing TS domain emission** (the `render-expr`/`render-stmt` that
> already serve Hono) — so the new work is the framework *shell*, not a
> language renderer. Modelled as a **`transport: nest` on `platform: node`**
> per [`platform-realization-axes.md`](./platform-realization-axes.md).
> Builds on [`docs/platforms.md`](../platforms.md) and
> [`docs/generators.md`](../generators.md). Sibling of
> [`go-backend.md`](./go-backend.md) (new ecosystem / *reach*) — NestJS
> adds the enterprise tier of an ecosystem Loom already serves (*depth*).

## TL;DR

Add a **NestJS** backend — `@nestjs/common` modules/controllers/providers
over Express (or Fastify), **TypeORM** (or MikroORM) over **Postgres**,
optionally **`@nestjs/cqrs`** for the command/query/event bus. It reuses
the platform-neutral `EnrichedLoomModel` *and* most of the existing
TypeScript generator: no new IR, no new language renderer.

The decisive fact, and why this is cheaper than Go/Java/PHP: **the
TypeScript expression and statement renderers already exist.** The Hono
backend's `TS_TARGET` (the leaf table for the shared `ExprTarget`) and its
`render-stmt.ts` render domain logic to TypeScript today. NestJS executes
**the same TypeScript domain logic** — only the *framework shell* around
it (DI modules, decorator controllers, providers, bootstrap) differs.

**Effort: ~3–5 engineer-weeks** for Hono-parity, or **~1.5–2.5 weeks**
for a walking skeleton — roughly **half a new-language backend**, because
the expensive half (name-resolved expression/statement rendering) is
inherited verbatim.

## Why NestJS — and why ahead of PHP

- **It reuses the TS domain emission.** A new-language backend (Go, Java,
  PHP) spends most of its budget on `render-expr`/`render-stmt` (17 + 9
  arms, name-resolution-aware). NestJS spends **zero** there — it is the
  same language as an existing backend. That is the cheapest new-backend
  in the matrix.
- **It is the Angular pairing.** "Angular + NestJS" is a recognised
  full-stack TS combo — shared module/DI/decorator philosophy (NestJS is
  explicitly Angular-inspired). With Angular prioritised, NestJS completes
  the enterprise-TS story.
- **It maps cleanly onto a generator.** Opinionated and regular — every
  controller, provider, and module has the same shape — so generated code
  reads idiomatic, the same property that makes Angular a clean target.
- **It has a real DDD story Hono lacks.** NestJS modules ≈ bounded
  contexts; first-class DI for repositories/services; and **`@nestjs/cqrs`**
  ships a command/query/event bus — a **MediatR / Symfony-Messenger
  analog**. So the `cqrs` style and a layered/hexagonal architecture are
  *native*, where Hono is functional-routes-only.

The honest caveat: NestJS adds **depth** (the structured/enterprise tier
of the TS ecosystem), not **reach** (a new language). That is why it
ranks behind Go (new ecosystem, microservice ubiquity, the
platform-neutrality proof) — but **ahead of PHP**, which costs a full
new-language backend for legacy/CMS-weighted reach.

## What is reused vs genuinely new

This is the whole case, so it is worth being explicit. Anchored to the
TypeScript/Hono generator (`src/generator/typescript/`, ≈ 7.2k LOC / 28
files):

| Concern | Reuse from the TS/Hono generator | New for NestJS |
|---|---|---|
| **Expression rendering** (17 `ExprIR` arms) | **`TS_TARGET` verbatim** (the shared `ExprTarget` dispatcher in `_expr/target.ts`) | none |
| **Statement rendering** (9 `StmtIR` arms) | **`render-stmt.ts` verbatim** | none |
| ids / value-objects / enums / events / DTOs | **mostly verbatim** — plain TS classes/types, framework-neutral | thin decorator stamping only |
| `wireShape` consumption | **verbatim** (same enriched IR) | none |
| `MigrationsIR` → migrations | **reuse** `sql-pg.ts` / the TS migration shape | TypeORM migration-class wrapper |
| **HTTP surface** | — | **new**: `@Controller`/`@Get`/`@Post` decorator controllers + route binding |
| **DI / module wiring** | — | **new**: `@Module({controllers, providers})` graph, provider registration |
| **Repositories** | repository *logic* reusable | **new**: TypeORM `Repository<E>` providers (or MikroORM — partly exists via the Hono `mikroorm` adapter) |
| **Validation** | — | **new**: `class-validator` decorator DTOs (`@IsString()`, …) |
| **Bootstrap** | — | **new**: `main.ts` + `AppModule` + `NestFactory.create` |
| **CQRS** (optional) | — | **new**: `@nestjs/cqrs` command/query/event bus wiring |

So the genuinely-new surface is the **framework shell** — controllers,
modules/DI, TypeORM providers, `class-validator` DTOs, bootstrap, optional
CQRS. Call it **~3–4.5k LOC of new emission**, against Go's ~7k (Go pays
for a new-language `render-expr`/`render-stmt` NestJS inherits).

## Framework choices

| Axis | Choice | Rationale |
|---|---|---|
| Platform / axis | **`platform: node`, `transport: nest`** | Same node platform as Hono; NestJS is a transport+structural-foundation (like Phoenix spanning both) selected on the deployable. |
| HTTP adapter | **Express** (Fastify a flip) | NestJS default; affects only the bootstrap line. |
| ORM (default) | **TypeORM** | The conventional NestJS pairing; decorator entities (`@Entity`/`@Column`) mirror the `class-validator` decorator idiom. **MikroORM** is the alt adapter — and the Hono backend already has a `mikroorm` adapter to borrow from. |
| Style | **layered** default; **`cqrs`** via `@nestjs/cqrs` as a real fast-follow (cheap — the bus *is* the framework) | Mirrors how .NET shipped layered + cqrs. |
| DB | **Postgres** | Same sidecar story as Hono (`composeService`); reuse `MigrationsIR`. |
| Build / deps | **npm/pnpm** (`package.json`) | Reuse the `stacks/v*` manifest machinery — same ecosystem as Hono. |

## Adapter menu (`src/platform/` selection, mirroring the realization axes)

```
transport: nest            (vs hono)        ← the new value on platform: node
persistence:
  state → typeorm   (TypeORM)               ← DEFAULT, full impl
  state → mikroorm  (MikroORM)              ← borrow from the Hono mikroorm adapter
style:
  layered  (Controller → Service → Repository)  ← DEFAULT
  cqrs     (@nestjs/cqrs command/query/event bus) ← stub v1 → fast-follow (cheap; the bus is the framework)
layout:
  byLayer
  byFeature  (idiomatic in Nest — module-per-feature)
```

## The fiddly parts

1. **DI graph correctness.** The new risk surface is the `@Module`
   provider/controller graph — every repository/service must be registered
   and injectable. Mechanical but the place a skeleton first goes wrong.
2. **Wire-shape conformance** — `conformance-parity.yml` per-PR gate:
   NestJS JSON must be byte-compatible with the other backends. *Lower
   risk than a new-language backend* — it serializes the same TS DTOs the
   Hono backend already gets right; consume `agg.wireShape` directly.
3. **TypeORM vs the existing MikroORM adapter.** Decide whether TypeORM is
   the default or whether to lead with MikroORM (already partly emitted
   for Hono) to maximise reuse. TypeORM is the more idiomatic NestJS
   default; MikroORM is the cheaper first cut.

## Tests & CI

Lighter than a new-language backend (no new compiler toolchain — it's the
Node toolchain already in CI):

- `nest-build.yml` — `tsc --noEmit` + `nest build` (the `hono-build.yml`
  analog; same Node container).
- `nest-obs-e2e.yml` — boot the backend, assert the observability catalog
  envelope on stdout (the `hono-obs-e2e.yml` analog).

Reuse of the Node toolchain + the existing TS test patterns means CI
standup is **days, not the ~1 week a fresh language toolchain costs.**

## Phasing

1. **Skeleton (wk 1–1.5)** — `transport: nest` wiring + module/controller/
   provider/bootstrap for one aggregate, reusing TS expr/stmt rendering;
   `composeService` + Postgres; boot something.
2. **Parity (wk 1.5–3)** — full controller/repository/DTO/validation emit,
   TypeORM migrations → pass `conformance-parity` and `nest-build`.
3. **Differentiators (wk 3–4.5)** — workflows, views, auth (Nest guards),
   observability e2e, **`@nestjs/cqrs` style promoted** (cheap), MikroORM
   adapter.
4. **Hardening (wk 4.5–5)** — `examples/*.ddd` coverage, docs rows in
   `platforms.md` / `generators.md`.

## Decisions to pin before starting

- TypeORM vs MikroORM default (→ reuse vs idiom). **TypeORM default,
  MikroORM as the borrow-from-Hono alt.**
- Express vs Fastify (→ bootstrap line only). **Express.**
- `transport: nest` value vs a separate platform (→ axis modelling).
  **`transport: nest` on `node`** — same language, reuse-maximising.
- Promote `@nestjs/cqrs` in v1 or stub? **Stub v1, fast-follow** (unusually
  cheap — the bus is first-class in the framework).

## Cross-references

- [`platform-realization-axes.md`](./platform-realization-axes.md) — the
  `transport:` axis NestJS plugs into on `platform: node`.
- [`go-backend.md`](./go-backend.md) — the *reach* sibling (new ecosystem);
  NestJS is the *depth* sibling (cheap, reuses TS emission).
- [`angular-frontend.md`](./angular-frontend.md) — the Angular pairing that
  makes NestJS the enterprise-TS full-stack completion.
- [`render-expr-target-unification.md`](./render-expr-target-unification.md)
  — the `TS_TARGET` NestJS inherits **verbatim** (the cost saving).
- [`docs/platforms.md`](../platforms.md) / [`docs/generators.md`](../generators.md)
  — surface contract + per-backend feature matrix (add a Nest column).
