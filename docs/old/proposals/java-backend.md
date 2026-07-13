# Java backend — Spring Boot / JPA generator

> Status: **SHIPPED** (#1110 core; #1113 / #1119 / #1127 follow-ups).
> The backend exists in-tree (`platform: java`, `java@v1` —
> `src/platform/java.ts` + `src/generator/java/`); the execution record
> lives in
> [`../plans/java-backend-implementation.md`](../plans/java-backend-implementation.md).
> The headline differentiator landed: java is the first backend
> consuming `CriterionIR` directly (`<Agg>Criteria` `Specification<T>`
> factories + `JpaSpecificationExecutor` retrievals) — the
> criterion-everywhere prerequisite this proposal originally deferred
> behind shipped first (selectability oracle + reified criteria).
> Also shipped: paged finds + paged `Repo.run`, workflows (loops +
> workflow-level `emit`), exception-less returns, TPH (JPA
> SINGLE_TABLE), single containments, seeding, capability filters
> (`@SQLRestriction`), the embedded-SPA fullstack mount, the `ddd new`
> starter, JUnit emission, the observability envelope, and the
> `java-build.yml` / `java-obs-e2e.yml` CI gates.  Remaining gated
> tails (unions in find/payload positions, `persistedAs(eventLog)`,
> `shape(document|embedded)`, resource-op clients, `hosts:` UI
> hosting, compose-stack conformance) are tracked in the plan doc.
> The original design rationale below is retained for context; where it
> disagrees with the shipped code, the code (and `docs/generators.md`'s
> Java section) wins — notably the build is **Gradle (Kotlin DSL)** as
> the proposal envisioned (an interim Maven shell was revised out), and
> the default application style is **layered**.

## TL;DR

Add a **Spring Boot + Spring Data JPA (Hibernate) + Postgres** backend,
in-tree at `src/platform/java.ts` + `src/generator/java/`, implementing
`PlatformSurface`. It reads the platform-neutral `EnrichedLoomModel`
directly — no new IR, no new lowering phase, no language change. The
yardstick is the existing **.NET backend (~8,073 LOC, 32 files)**: Java
lands near that, a touch lower (the second OOP/ORM backend inherits
patterns from the first).

**Effort: ~6–9 engineer-weeks** for parity with .NET, or **~3–4 weeks**
for a walking skeleton (entities + repos + REST + Postgres that passes
the build and wire-conformance gates, deferring workflows/views/auth/
observability).

The architecture front-loads the hard part: parse, scope, name-bind,
type-resolve, and enrich all happen **once** in the IR. A backend writes
**emitters, not a compiler**. Specifically, *not* required:

- **No re-resolution** — every IR node carries `refKind` (9), `callKind`
  (4), `receiverType` / `memberType`, `isCollectionOp`. The Java
  renderers dispatch on these.
- **No migration derivation** — `MigrationsIR` is derived once in phase ⑨
  (`migrations-builder.ts`, ~583 LOC, shared). Java only translates
  `MigrationStep[]` → Flyway/JPA syntax.
- **No new IR, no new phase** — `language/` and `ir/` are untouched.

## Why Java

It is the largest enterprise/DDD ecosystem Loom doesn't yet target, and
it is the one with the *richest* DDD-flavoured tooling — richer than
.NET in places (see below). A Java target makes Loom credible for the
Spring-shop majority and exercises the IR's platform-neutrality claim a
fourth time.

## Framework choices

| Axis | Choice | Rationale |
|---|---|---|
| Web / DI | **Spring Boot** | The conventional, most-documented Java stack; affects only the bootstrap + DI emit shape. |
| ORM (default) | **Spring Data JPA over Hibernate** | Closest mental model to EF Core; `JpaRepository` gives `save`/`findById`/`findAll` for free. |
| Build | **Gradle** (Maven a config flip) | Templated build files (~150 LOC), mechanical either way. Mirrors `stacks/v*` for the dependency/devDependency manifest. |
| DB | **Postgres** | Same sidecar story as .NET (`composeService`). |

### The three layers, and what the emitter generates

`Spring Data JPA → JPA (spec) → Hibernate (impl)` are *layers*, not
alternatives. Entities are identical regardless (JPA annotations,
Hibernate-provided). The choice bites only at the **repository** layer:

- **Spring Data JPA** — emit an *interface* `extends JpaRepository<E,Id>`
  + `@Query` JPQL for IR-derived finds. Idiomatic, minimal boilerplate.
- **Plain JPA + Criteria API** — emit a *class* with `EntityManager`
  building `CriteriaBuilder` predicates. The closer structural twin to
  how the .NET/TS find-builders render the typed find-filter `ExprIR` →
  query-builder calls.

**Recommendation:** Spring Data JPA as the framework, but render
IR-derived finds as **`@Query` JPQL** (derived method names can't
express an arbitrary `ExprIR` filter). Read the `jpa` adapter as "Spring
Data JPA over Hibernate, JPQL-rendered finds," not raw Hibernate.

## The DDD-flavoured ecosystem (and the Marten question)

There is no single "Marten for Java" (Postgres-JSONB document store **+**
event store in one library); the concern is split:

| Java project | Role | .NET analog |
|---|---|---|
| **jMolecules** | DDD building-block annotations: `@AggregateRoot`, `@Entity`, `@ValueObject`, `@Identity`, `@Repository`, `@DomainEvent`, plus Layered/Onion/Hexagonal package markers. | (no real analog) |
| **Spring Modulith** | Modular-monolith modules + domain-event publication registry; detects jMolecules blocks. | — |
| **Axon Framework** | Full CQRS + Event Sourcing framework; pluggable event store (JPA/Postgres or Axon Server). | Marten (event-store side) |
| **EventStoreDB / Eventuate** | Dedicated event stores w/ Java clients. | EventStoreDB |

**The jMolecules opportunity is unique to Java.** Its annotations map
**1:1 onto Loom's IR vocabulary** (aggregate root, value object, entity,
identity, repository, domain event). The Java entity emitter can stamp
`@AggregateRoot` / `@ValueObject` / `@Identity` / `@DomainEvent` onto
generated classes — making the output idiomatically DDD *and* yielding
free ArchUnit boundary verification. No other backend gets that.

## Adapter menu (`src/platform/java.ts`, mirroring `dotnet.ts`)

```
persistence:
  state    → jpa     (Spring Data JPA / Hibernate)   ← DEFAULT, full impl   [≈ efcore]
  state    → jooq    (typesafe SQL)                   ← stub v1              [≈ dapper]
  eventLog → axon    (Axon event sourcing)            ← stub v1              [≈ marten]
style:
  layered  (Controller → Service → Repository)        ← DEFAULT
  cqrs     (command/query split, optionally Axon)     ← stub v1
  (hexagonal — ports & adapters; idiomatic in Java DDD, jMolecules-supported — later)
layout:
  byLayer
  byFeature   (package-by-feature — idiomatic in Spring/Modulith)

adapterDefaults: persistence { state: "jpa", eventLog: "axon" }, style: "layered", layout: "byFeature"
```

This gives the two persistence styles requested (the EF-Core-role `jpa`
real + the Dapper-role `jooq` stub) plus `axon` as the Marten/eventLog
analog — exactly how .NET shipped `efcore` real with `dapper`/`marten`
stubbed. Promote `jooq` to a full second persistence adapter as a
fast-follow (+~1–1.5 wk for the SQL-vs-ORM repository/find divergence).

> Note: Spring Data JPA's "declare-an-interface, get-a-generated-repo"
> trick has **no de-facto .NET equivalent** — EF Core folds the
> repository (`DbSet<T>`) and unit-of-work (`DbContext`) into its core,
> and replaces derived-method-name queries with LINQ. (DataObjects.Net,
> NHibernate, etc. are *ORM-tier* peers to EF Core, not Spring-Data-tier
> convenience layers.) The asymmetry is benign — it's a Java-side bonus
> with nothing to keep parity with.

## The Specification<T> differentiator (depends on criterion-everywhere)

Criterions are the DDD Specification pattern, and **Spring Data ships
`Specification<T>` as a first-class, composable, reusable type** — a 1:1
match for `CriterionIR` (named ✓, parameterized via factory args ✓,
composable via `.and()`/`.or()`/`Specification.not()` ✓). No other
backend has a runtime construct this close; today every backend *inlines*
criterions to `ExprIR` and `CriterionIR` is consumed by none (the IR
comment reserves it for *"future query emission"*).

Java can be the **first backend to consume `CriterionIR` directly**:

| Path | Criterion fate | Cost |
|---|---|---|
| **A. JPQL `@Query` (inline)** | inlined to `ExprIR`, rendered per find — like every backend | free (falls out of the find-emitter) |
| **B. Criteria → `Specification<T>`** | each selectable `CriterionIR` → reusable `CustomerSpecs.inRegion(r)` factory; finds compose with `.and()` | +~0.5 wk; **first consumer of `CriterionIR`** |

Path B is why this proposal waits on
[`criterion-everywhere.md`](./criterion-everywhere.md): only the
**selectable** subset of a criterion can become a `Specification<T>`
(`(root, query, cb) -> …` is the JPA Criteria API, which `Specification`
wraps). The selectability model decides exactly which criterions qualify;
`currentUser.<scalar>` binds via Spring's `SecurityContextHolder`. Path B
is the half-week that makes the Java output look hand-written by someone
who knows DDD — but it is only sound on top of the selectability model.

## What gets written (anchored to .NET = 8,073 LOC / 32 files)

| Piece | .NET reference | Java estimate |
|---|---|---|
| `PlatformSurface` impl (`src/platform/java.ts`) | 139 | ~150 |
| Orchestrator (`index.ts`) | 676 | ~700 |
| Entity / JPA model emit | `entity.ts` 396 + `efcore.ts` 326 | ~700 |
| Repository emit | `repository.ts` 508 | ~500 |
| REST API emit | `api.ts` 489 | ~500 |
| Bootstrap (`Application.java` + Spring config) | `program.ts` 597 | ~500 |
| DTOs / mapping | `dto.ts` 46 + `dto-mapping.ts` 403 | ~450 |
| **`render-expr.ts`** (17 ExprIR variants) | 405 | ~450 |
| **`render-stmt.ts`** (9 StmtIR variants) | 131 | ~150 |
| ids / value-objects / enums / events | ~150 | ~150 |
| Migration emit (`MigrationStep[]` → Flyway/JPA) | `migrations.ts` 75 | ~250 |
| Validators emit (Bean Validation) | `validator-emit.ts` 405 | ~350 |
| Join entities (M:N) | `join-entities.ts` 117 | ~120 |
| Adapters (persistence/style/layout) | ~625 | ~500 |
| Grammar + validator wiring (`'java'` platform) | small | ~50 |
| Build manifest (Gradle templates, like `stacks/v*`) | — | ~150 |
| **Subtotal** | **~8,070** | **~6,300–8,000** |

### The fiddly parts

1. **`render-expr.ts` (17 variants)** — `match`, `convert` (primitive
   coercions), `isCollectionOp` method calls (map/filter/any/all → Java
   Streams or query folds), `value-object-ctor` vs `private-operation`
   dispatch. Streams-vs-loops for collection ops is the main
   language-specific judgement call.
2. **Wire-shape conformance** — `conformance-parity.yml` is a per-PR
   gate: Java's JSON wire output must be byte-compatible with the other
   backends for the same `.ddd`. Consume `agg.wireShape` directly; this
   is where most debugging time goes, but it is a precise mechanical
   target.

## Tests & CI (do not under-budget)

Matching .NET means **~10–13 new test files** (generator,
access-modifiers, datasource-schema, document-emission, migrations-emit,
wire-conformance; ~4 adapter tests; e2e build + observability) plus **new
CI workflows** mirroring `dotnet-build.yml` and `dotnet-obs-e2e.yml`:

- `java-build.yml` — Gradle `build`/compile-as-error in a JDK container.
- `java-obs-e2e.yml` — boot the backend, assert the observability catalog
  envelope on stdout.

Standing up the JDK Docker toolchain and getting the build green is
realistically **1–1.5 weeks on its own**.

## Phasing

1. **Skeleton (wk 1–2)** — `PlatformSurface` + `'java'` grammar/validator
   wiring + entity/repo/REST/bootstrap for one simple aggregate;
   `composeService` + Postgres; boot *something*.
2. **Renderers (wk 2–4)** — full `render-expr`/`render-stmt`, migrations,
   Bean Validation, DTO mapping → pass `conformance-parity` and
   `java-build`.
3. **Parity features (wk 4–7)** — workflows, views, auth, observability
   e2e, adapters; **Specification<T> (Path B)** lands here, on top of the
   merged criterion-everywhere selectability model.
4. **Hardening (wk 7–9)** — edge cases across `examples/*.ddd`, CI shards,
   docs rows in `platforms.md` / `generators.md`.

## Decisions to pin before starting

- Spring Boot vs Quarkus/Micronaut (→ bootstrap + DI shape). **Spring Boot.**
- JPA/Hibernate vs jOOQ/MyBatis as default (→ cheapest port). **JPA.**
- Gradle vs Maven (→ build templates). **Gradle.**
- Full parity vs skeleton first (→ defer workflows/views/auth/obs ≈ 2,000
  LOC). **Skeleton first.**
- Emit jMolecules annotations? **Yes** — near-free, high idiomatic value.

## Cross-references

- [`criterion-everywhere.md`](./criterion-everywhere.md) — **prerequisite**
  for the Path B `Specification<T>` emission (selectability model).
- [`docs/platforms.md`](../../platforms.md) — `PlatformSurface` contract,
  `family@version` pinning, in-tree vs out-of-tree backend homes.
- [`docs/generators.md`](../../generators.md) — per-backend feature matrix
  (add a Java column).
- [`docs/old/proposals/platform-directory-layout.md`](./platform-directory-layout.md)
  — per-`<family>/v<N>/` homes; a future `java@vN` package follows the
  hono precedent.
- [`docs/criterion.md`](../../criterion.md) — shipped criterion core.
