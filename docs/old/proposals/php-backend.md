# PHP backend — Symfony + Doctrine generator

> Status: **PROPOSED (vision / not scheduled).** Captures the design and
> effort shape for a domain-logic backend in PHP, targeting the
> **enterprise / DDD-native** PHP market. **No grammar/IR change** —
> purely additive codegen on the `PlatformSurface` contract. Builds on
> [`docs/platforms.md`](../../platforms.md) and
> [`docs/generators.md`](../../generators.md). Sibling of
> [`java-backend.md`](./java-backend.md) (since **shipped**) and
> [`go-backend.md`](./go-backend.md) — the three new-backend studies; PHP
> is the **DDD-idiom** member of that set, where Go is the
> **microservice-ubiquity** member.

## TL;DR

Add a **PHP** backend — **Symfony** (HttpKernel + Messenger) with
**Doctrine ORM** over **Postgres** — in-tree at `src/platform/php.ts` +
`src/generator/php/`, implementing `PlatformSurface`. It reads the
platform-neutral `EnrichedLoomModel` directly: no new IR, no new lowering
phase, no language change. The yardstick is the .NET backend (≈ 13.7k LOC
/ 48 files) — PHP/Symfony is the **closest structural twin to .NET** in
the matrix (OOP, attribute-driven ORM, DI container, mediator/Messenger),
so it inherits the most patterns from an existing backend and lands a
touch below: **~7–10k LOC**.

**Effort: ~6–9 engineer-weeks** for .NET-class parity, or **~3–4 weeks**
for a walking skeleton (entities + repos + REST + Postgres passing the
build and wire-conformance gates, deferring workflows/views/auth/
observability).

The hard part is already done once in the IR. A backend writes
**emitters, not a compiler**. Specifically *not* required:

- **No re-resolution** — every IR node carries `refKind` (9), `callKind`
  (4), `receiverType` / `memberType`, `isCollectionOp`. The PHP renderers
  dispatch on these.
- **No migration derivation** — `MigrationsIR` is derived once in phase ⑨
  (`migrations-builder.ts`, shared). PHP only translates `MigrationStep[]`
  → Doctrine Migrations PHP classes (or reuses `sql-pg.ts` for raw SQL up/
  down).
- **No new IR, no new phase** — `language/` and `ir/` are untouched.

## Why PHP — and why this is the *DDD-native* pick

PHP is dismissed as "not enterprise," which is exactly backwards for DDD:
the **modern PHP community effectively standardised the practitioner
vocabulary of DDD** (Vaughn Vernon's *Implementing DDD* PHP companions,
the `prooph`/Broadway event-sourcing libs, the ubiquitous "DDD in
Symfony" hexagonal-architecture template). Symfony + Doctrine is a
genuinely DDD-friendly stack:

- **Doctrine** is a data-mapper ORM (unlike Active Record): entities are
  POPOs with no persistence base class — the cleanest possible aggregate
  emission, no framework intrusion into the domain object. This is a
  *better* fit for Loom's aggregate model than EF Core's `DbSet` coupling.
- **Symfony Messenger** is a first-class command/query/event bus — a
  direct analog to .NET's MediatR, so the `cqrs` style and domain-event
  dispatch port almost mechanically from the .NET emitter.
- **PHP 8 attributes** (`#[ORM\Entity]`, `#[Route]`, `#[Assert\…]`) mirror
  .NET attributes 1:1 — the entity/route/validator emit shapes transfer
  with minimal rethinking.

It also reaches a large market the other backends don't touch (the PHP
share of the server web is still enormous), and it makes Loom credible
for the Symfony/Laravel-shop majority. **Symfony over Laravel** for v1:
Laravel's Eloquent is Active Record (a persistence base class on every
model — fights the clean-aggregate emission), and Laravel's conventions
are less hexagonal. Laravel is a viable second adapter family later.

## Framework choices

| Axis | Choice | Rationale |
|---|---|---|
| Web / DI | **Symfony** (HttpKernel) | The DDD-conventional PHP stack; DI container + attribute routing map onto the .NET bootstrap shape. |
| ORM (default) | **Doctrine ORM** | Data-mapper (POPO entities); the closest clean-aggregate fit in the matrix. The `efcore`-role adapter. |
| Command bus | **Symfony Messenger** | MediatR analog; powers the `cqrs` style + domain-event dispatch. |
| Validation | **Symfony Validator** (`#[Assert\…]`) | Attribute-driven, mirrors .NET Bean/DataAnnotations emit. |
| Build / deps | **Composer** (`composer.json`) | One templated manifest; mirrors `stacks/v*`. |
| DB | **Postgres** | Same sidecar story as .NET (`composeService`); `MigrationsIR` → Doctrine Migrations. |

## Adapter menu (`src/platform/php.ts`, mirroring `dotnet.ts`)

```
persistence:
  state    → doctrine  (Doctrine ORM)              ← DEFAULT, full impl   [≈ efcore]
  state    → dbal      (Doctrine DBAL, typed SQL)  ← stub v1              [≈ dapper]
  eventLog → prooph    (prooph event store)        ← stub v1              [≈ marten]
style:
  layered  (Controller → Handler → Repository)     ← DEFAULT
  cqrs     (Messenger command/query split)         ← stub v1 → fast-follow (Messenger makes this cheap)
layout:
  byLayer
  byFeature  (idiomatic in Symfony DDD templates)

adapterDefaults: persistence { state: "doctrine", eventLog: "prooph" }, style: "layered", layout: "byFeature"
```

This mirrors how .NET shipped `efcore` real with `dapper`/`marten`
stubbed. The `cqrs` style is unusually cheap here because Messenger *is*
the bus — promoting it to full is a fast-follow, not a rewrite.

## What gets written (anchored to .NET ≈ 13.7k LOC / 48 files)

| Piece | .NET reference | PHP estimate |
|---|---|---|
| `PlatformSurface` impl (`src/platform/php.ts`) | 139 | ~150 |
| Orchestrator (`index.ts`) | 676 | ~700 |
| Entity emit (Doctrine attributes on POPOs) | entity+efcore ~720 | ~650 |
| Repository emit (Doctrine `EntityRepository` + DQL) | repository 508 | ~550 |
| REST API emit (Symfony controllers + attribute routes) | api 489 | ~500 |
| Bootstrap (`Kernel.php` + services config + Messenger) | program 597 | ~550 |
| DTOs / mapping | dto+mapping ~450 | ~450 |
| **`render-expr.ts`** (17 ExprIR variants, leaf-only `PHP_TARGET`) | 405 | ~450 |
| **`render-stmt.ts`** (9 StmtIR variants) | 131 | ~150 |
| ids / value-objects / enums (PHP 8.1 enums) / events | ~150 | ~180 |
| Migration emit (`MigrationStep[]` → Doctrine Migrations) | 75 | ~250 |
| Validators emit (Symfony `#[Assert\…]`) | validator-emit 405 | ~350 |
| Join entities (M:N, Doctrine `ManyToMany`) | join-entities 117 | ~120 |
| Adapters (doctrine/dbal persistence, style, layout) | ~625 | ~550 |
| Grammar + validator wiring (`'php'` platform) | small | ~50 |
| Build manifest (Composer templates, like `stacks/v*`) | — | ~150 |
| **Subtotal** | **~13,700** | **~7,000–9,500** |

### The fiddly parts

1. **`render-expr.ts` (17 variants)** — `match` (PHP 8 has a native
   `match` expression — a clean target), `convert` primitive coercions,
   `isCollectionOp` method calls (`array_map`/`array_filter`/`array_any`
   over Doctrine `Collection` vs DQL folds), money arithmetic (PHP has no
   decimal type — use `brick/math` or string-BCMath; **decide up front**,
   it's the one place PHP is awkward).
2. **Wire-shape conformance** — `conformance-parity.yml` per-PR gate:
   PHP's JSON output must be byte-compatible with the other backends.
   PHP's `json_encode` + a serializer (Symfony Serializer or hand-rolled
   `toArray`) is where most debugging goes; consume `agg.wireShape`
   directly, never hand-case (`naming.ts`).
3. **Floats/decimals** — PHP's lack of a native decimal makes money the
   single real language gap; `brick/math` `BigDecimal` is the
   recommendation, consistent with the IR's money model.

## The leaf-only target — one table, not a fourth dispatcher

Like Go and Java, PHP supplies a leaf-only `PHP_TARGET` table to the
shared `ExprTarget` dispatcher (`src/generator/_expr/target.ts`,
[`render-expr-target-unification.md`](./render-expr-target-unification.md)) —
the 17-arm dispatch + recursion are already shared; PHP fills the eight
divergence axes. PHP's native `match` expression and first-class enums
(8.1) make several arms unusually clean.

## Tests & CI

Matching .NET means **~10–13 new test files** plus **new CI workflows**
mirroring `dotnet-build.yml` and `dotnet-obs-e2e.yml`:

- `php-build.yml` — `composer install` + **PHPStan (max level)** /
  **Psalm** as the warnings-as-errors gate (PHP's static-analysis tier is
  the `tsc --noEmit` / `dotnet /warnaserror` analog) in a PHP container.
- `php-obs-e2e.yml` — boot the backend, assert the observability catalog
  envelope on stdout.

PHP has no compiler gate, so the **PHPStan/Psalm level is the quality
bar** — budget time to get generated code clean at max level (it is the
equivalent rigor to `dotnet /warnaserror`, and where most CI-hardening
time goes).

## Phasing

1. **Skeleton (wk 1–2)** — `PlatformSurface` + `'php'` grammar/validator
   wiring + entity/repo/controller/bootstrap for one aggregate;
   `composeService` + Postgres; boot *something*.
2. **Renderers (wk 2–4)** — full `render-expr`/`render-stmt`, Doctrine
   Migrations, Symfony Validator, serialization → pass `conformance-parity`
   and `php-build` (PHPStan max).
3. **Parity features (wk 4–7)** — workflows (Messenger), views, auth
   (Symfony Security), observability e2e; **`cqrs` style promoted** (cheap
   on Messenger).
4. **Hardening (wk 7–9)** — edge cases across `examples/*.ddd`, CI shards,
   docs rows in `platforms.md` / `generators.md`.

## Decisions to pin before starting

- Symfony vs Laravel (→ ORM model, conventions). **Symfony** (data-mapper
  Doctrine = clean aggregates; Laravel/Eloquent later as a second family).
- Doctrine ORM vs DBAL as default (→ cheapest port). **Doctrine ORM.**
- Money representation: `brick/math` vs BCMath strings (→ `render-expr`
  money arithmetic). **`brick/math` BigDecimal.**
- PHPStan vs Psalm as the gate, and what level. **PHPStan max.**
- Promote `cqrs`/Messenger in v1 or stub? **Stub v1, fast-follow** (it is
  unusually cheap given Messenger).

## Cross-references

- [`docs/platforms.md`](../../platforms.md) — `PlatformSurface` contract.
- [`docs/generators.md`](../../generators.md) — per-backend feature matrix
  (add a PHP column).
- [`render-expr-target-unification.md`](./render-expr-target-unification.md)
  — the `ExprTarget` seam PHP plugs a `PHP_TARGET` table into.
- [`java-backend.md`](./java-backend.md) — the other OOP/attribute-ORM
  twin; PHP inherits the most from .NET, Java from .NET second.
- [`go-backend.md`](./go-backend.md) — the structurally-opposite sibling
  (no classes, errors-as-values).
