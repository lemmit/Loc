# Java backend (Spring Boot + JPA) — implementation plan

> **Status:** S0–S9 SHIPPED (see the execution
> record below). Supersedes the effort-shape sketch in
> [`../proposals/java-backend.md`](../proposals/java-backend.md). Each slice
> landed as one commit on `npm test`-green trees; the generated output was
> additionally verified at runtime against a local Postgres 16 (boot, Flyway,
> full CRUD/op/find/workflow/view/auth/422 behaviour, observability envelope).
>
> ## Execution record
>
> - **S0–S7, S9 — done.** Wiring + skeleton, `JAVA_TARGET` renderers, domain
>   layer, JPA persistence + Flyway, the REST/wire layer, auth/extern/
>   workflows/views, JUnit test emission + observability + the
>   `LOOM_JAVA_BUILD` / `LOOM_OBS_E2E_JAVA` opt-in suites
>   (`npm run test:java` / `test:obs-java`), CI workflows
>   (`java-build.yml`, `java-obs-e2e.yml`), docs.
> - **S8 — done.** `examples/showcase.ddd` now ships a `javaApi`
>   deployable (Catalog/Builds/People, the same contexts as the other
>   backends, `auth: required`), and `test/e2e/e2e.test.ts` boots it as
>   the 5th compose service in the strict cross-backend OpenAPI parity
>   diff (`conformance-parity.yml`, `LOOM_E2E_STRICT_PARITY=1`): five
>   backends, ten pairwise comparisons (ops / cardinality / schemas /
>   fields / required), plus the 403 runtime-authorization parity.  The
>   showcase java project gradle-compiles and serves a 20-path
>   springdoc spec matching the cross-backend route contract; the
>   normalizer already strips java's `/health` `/ready` `/openapi.json`
>   probe paths.  CI runs the live 5-way diff on docker.
> - **Shipped post-merge (PR #1110 follow-ups, each boot-verified
>   against Postgres):** paged carriers (`Paged<T>` over Spring Data
>   `Pageable`); retrievals (`run<Name>` port methods: reified
>   criterion-ref retrievals ride `JpaSpecificationExecutor` + `Sort`,
>   composed `where`s fall back to `@Query` JPQL with `order by`);
>   reified criteria → `<Agg>Criteria` `Specification<T>` factories
>   (java is the first backend consuming `CriterionIR` directly);
>   retrieval-driven workflow loops (`repo-run` + `for-each`) including
>   paged `Repo.run(..., page:)` (the `OffsetLimitPageRequest`
>   Pageable); workflow-level `emit` (event record + `domain_event`
>   envelope); the `ddd new` java starter; first-boot seeding
>   (`<Ctx>SeedRunner`, ship-once `__loom_seed` marker, domain + raw
>   paths); root-level single containments (hidden owning `_parent`
>   @OneToOne, inverse mappedBy + orphanRemoval); exception-less
>   operation returns (sealed domain unions + Jackson-polymorphic wire
>   DTOs + controller ProblemDetail translation — java joined
>   `SUPPORTED_RETURN_BACKENDS`); capability filters → `@SQLRestriction`
>   (non-principal relational subset; java joined the limited-families
>   gate); TPH `sharedTable` inheritance (JPA SINGLE_TABLE +
>   @DiscriminatorColumn/@DiscriminatorValue, shared `<Base>Id` threaded
>   through repos / services / controllers — java joined `TPH_CAPABLE`);
>   the embedded-SPA fullstack mount (`ui:` → /api route prefix,
>   SpaWebConfig with the index.html fallback, ClientApp/ React project,
>   node Dockerfile stage — the `hosts:` form stays gated).  Fixtures
>   under `test/e2e/fixtures/java-build/` pin each in the
>   `LOOM_JAVA_BUILD` matrix.
>   Post-#1127: union finds (`Order or NotFound` / `Order option` —
>   optional-twin repo/service, tagged 200 wire record, problem /
>   bare-404 absence; java joined `SUPPORTED_UNION_BACKENDS`);
>   resource clients (S3 / RabbitMQ / HttpClient classes + workflow
>   resource-op call sites + Gradle dep merge; restApi boot-verified
>   against a stub); event sourcing (`persistedAs(eventLog)` — plain
>   domain class folding the stream via appliers, JdbcTemplate impl
>   over the shared `<agg>_events` table, in-memory find folds,
>   create via the action's params; java joined
>   `EVENT_SOURCING_BACKENDS`; boot-verified incl. preconditions over
>   folded state).
>   Post-#1134: `shape(document)` (whole aggregate in one jsonb column
>   via a field-visibility Jackson mapper, version-bumping upserts,
>   in-memory find folds) and `shape(embedded)` (containments fold into
>   jsonb columns via the Hibernate JSON FormatMapper swapped for the
>   same field-visibility mapper; the root stays a queryable @Entity).
>   Post-#1146: lifecycle stamps (`stamp onCreate`/`onUpdate` →
>   `_stampOnCreate`/`_stampOnUpdate` entity methods the service calls
>   before save — closes the prior silent-drop where `createdAt` came
>   from the request; `currentUser` stamps resolve to the principal id (the service threads
>   `currentUser`, the entity assigns `currentUser.id()`) under auth;
>   event-sourced stamps and currentUser stamps without auth stay
>   fail-fast gated, `loom.java-stamp-unsupported`).
> - **Deferred features — all fail-fast gated, never silent:**
>   reference collections on `shape(embedded)` aggregates
>   (`loom.java-embedded-refcoll-unsupported` — Hibernate's
>   structured-JSON path bypasses the FormatMapper for @Embeddable ids),
>   part-declared single containments
>   (`loom.java-single-containment-unsupported`), `hosts:` UI hosting
>   (`loom.java-fullstack-unsupported`), principal-referencing filters /
>   non-relational filter shapes (`loom.context-filter-unsupported`),
>   provenance + per-op audited (gated like .NET).
>
> The proposal's stated blocker — criterion-everywhere — had **shipped**
> before this work started: the selectability oracle
> (`firstNonQueryableNode`) gates queryability at IR-validate time and all
> backends emit reified criteria. The `Specification<T>` emission therefore
> needs no model work, only the emitter follow-up.

## Pinned decisions

| Decision | Choice | Notes |
|---|---|---|
| Platform keyword / family | `java` | Canonical family name like `dotnet` / `node` / `elixir`; no aliases needed. Registers as `java@v1` (`BUILTIN_PLATFORM_LATEST`), in-tree at `src/platform/java.ts` (the elixir precedent). |
| Web / DI | **Spring Boot 3.x** (Spring MVC `@RestController`) | SpringDoc OpenAPI for the spec endpoint. |
| Language level | **Java 21** (LTS) | Records, sealed interfaces, switch expressions — all load-bearing for the emit shape. |
| ORM | **Spring Data JPA over Hibernate** (adapter `jpa`, real) | `jooq` and `axon` registered as honest stubs, mirroring .NET's `marten` stub pattern. |
| Build | **Gradle (Kotlin DSL)** — `build.gradle.kts` + `settings.gradle.kts`, no wrapper jar committed | Revised from the original Maven pick on review feedback: the wrapper-jar concern is a practical non-issue (auditable ~43KB, SHA-256 pinned, or `gradle wrapper` on demand), and Gradle wins on build speed, the Kotlin DSL, and multi-module/composite builds.  Docker builds ride the `gradle:8-jdk21` base image; CI uses the runner's Gradle. |
| App style default | **`layered`** (Controller → Service → Repository), real | Idiomatic Spring, per the proposal. `cqrs` registered as a stub (the inverse of .NET, where `cqrs` is real and `layered` is the stub). |
| Layouts | `byLayer` + `byFeature`, both real | Mirrors .NET; `byFeature` is package-by-feature, idiomatic Spring/Modulith. |
| jMolecules | **Yes** | Stamp `@AggregateRoot` / `@ValueObject` / `@Identity` / `@DomainEvent` / `@Repository` on generated types. Metadata-only dep. |
| Migrations | **Flyway-style versioned SQL** (`V<N>__*.sql`) | Rendered from the shared `MigrationsIR` via the existing Postgres SQL renderer (`src/generator/sql-pg.ts`); executed by `flyway-core` on boot. No re-derivation. |
| Validation | Explicit validator classes (FluentValidation-analog shape) on the request DTO boundary | Bean Validation annotations where they fall out naturally; domain invariants stay in the aggregate (parity rule: invariants are domain code, not annotations). |
| Test emission | `test "name"` → **JUnit 5** classes; `test e2e` → existing platform-neutral vitest+fetch path | e2e dispatch is automatic from the target deployable's platform — no DSL change. |
| Parity bar | **Mirror the .NET profile** | Everything .NET does for real, Java does for real — including event sourcing on JPA, fullstack UI mounting, criteria/`Specification<T>`. Where .NET *gates* (provenanced fields, per-op `audited`), Java gates with the same `loom.*-unsupported` fail-fast codes. |

## Architecture constraints (non-negotiable)

- **No new IR, no new phase, no language change** beyond the `'java'` platform
  keyword. The backend consumes `EnrichedLoomModel` directly: `wireShape`,
  `refKind`, `callKind`, `receiverType`/`memberType`, `isCollectionOp`,
  `MigrationsIR` — never re-resolve, never re-derive.
- **Idiomatic internals, tiny public surface.** The only contract is
  `PlatformSurface` (`src/platform/surface.ts`). Internals mirror the *shape*
  of `src/generator/dotnet/` (orchestrator + `emit/*` + adapters + renderers)
  but emit idiomatic Spring, not transliterated C#.
- **Expression rendering is a leaf table.** Java supplies `JAVA_TARGET`
  implementing `ExprTarget<JavaRenderContext>` (~130–200 LOC); the 17-arm
  dispatch + recursion stay in `src/generator/_expr/target.ts`. `render-stmt.ts`
  is per-backend flat dispatch over the 12 `StmtIR` kinds, like the others.
- **Procedural emission only** — `lines(...)` from `src/util/code-builder.ts`;
  no Handlebars. Naming through `src/util/naming.ts`.
- **Layering is test-enforced** (`pipeline-layering.test.ts`): nothing in
  `src/generator/java/` imports other platforms or `src/system/`.
- **Honest gates**: any unsupported feature fails fast at validate time with a
  `loom.*-unsupported` diagnostic — never a silent no-op.

## Wire-parity ground rules (where the debugging time goes)

`conformance-parity.yml` diffs OpenAPI across backends per-PR; the wire is the
contract. Java must match byte-level conventions:

- **Field order & casing** from `agg.wireShape` — Jackson `@JsonPropertyOrder`
  generated from the wire shape; camelCase property names (records' natural
  names; no naming-strategy surprises).
- **Datetimes** ISO-8601 UTC (`JavaTimeModule`, `WRITE_DATES_AS_TIMESTAMPS`
  off); **money** serialized to match .NET/Hono (amount/currency shape per
  `wireShape`); **BigDecimal** plain (no scientific notation).
- **Unions**: sealed interfaces + the tagged `type` discriminator field —
  emitted explicitly (record component or `@JsonTypeInfo` configured to the
  exact existing wire), verified by the union wire-parity test.
- **Errors**: same status/envelope mapping as .NET (`DomainException` → 400,
  not-found → 404, optimistic-concurrency → the same code .NET returns) via a
  `@RestControllerAdvice` mapper.
- **Routes**: same path shape as dotnet/node (no `/api` prefix —
  `src/system/e2e-render.ts` prefix stays `""` for java); `/health` (liveness)
  and `/ready` (DB-aware) endpoints; OpenAPI served where the conformance
  harness expects it.
- **JPA specifics** decided up front: UUID ids as `@Id` columns (no embedded-id
  ceremony on the wire); containments as owned collections with `@OrderColumn`
  for ordinal-bearing `X id[]` join entities (set semantics on the wire, like
  the others); `@Version` only where the concurrency story matches .NET.

## The wiring map (every touchpoint outside `src/generator/java/`)

| File | Change |
|---|---|
| `src/language/ddd.langium` | Add `'java'` to the `Platform` rule; `npm run langium:generate`, commit generated output (CI guards drift). |
| `src/ir/types/loom-ir.ts` | `Platform` union + `"java"`. |
| `src/ir/lower/lower-platform.ts` | Canonicalisation passthrough (no aliases); axis defaults for java. |
| `src/ir/lower/lower-deployment.ts` | Fullstack branch: `ui:` binding defaults (java mounts react like dotnet). |
| `src/platform/java.ts` | The `PlatformSurface` impl (next section). |
| `src/platform/registry.ts` | `platforms` record + `BUILTIN_PLATFORM_LATEST.java = "v1"` + `inTreeBackends` manifest entry. |
| `src/language/validators/deployable.ts` | Platform-name lists in messages; `ui:`-binding allowlist; version-pin validation picks up `java@v1` automatically via `parseBuiltinPlatformRef`. |
| `src/system/index.ts` | Capability predicates (`isTphCapable` etc.) — added **only in the slice that implements the capability**, never speculatively. |
| `src/system/likec4.ts` | `PERSISTENT` set + java. |
| `src/system/e2e-render.ts` | API path prefix stays `""` (match dotnet/node). |
| sweep | `grep -rn '"elixir"' src/ --include='*.ts'` in Slice 1 to catch any remaining per-platform branch (mermaid, compose, source-type predicates) the survey missed. |

`PlatformSurface` shape (mirrors `dotnet.ts`):
`name: "java"`, `defaultPort: 8080`, `needsDb: true`, `isFrontend: false`,
`mountsUi: true`, `hostableFrameworks: STATIC_BUNDLE_FRAMEWORKS`,
`reservedRepositoryFindNames: {"save", "findById", "findAll", …}` (the Spring
Data inherited surface), `composeService` → Postgres sidecar env
(`SPRING_DATASOURCE_URL=jdbc:postgresql://db:5432/<slug>` …), health
`/ready`, `adapters()` menu: persistence `{ jpa: real, jooq: stub, axon: stub }`,
styles `{ layered: real, cqrs: stub }`, layouts `{ byLayer: real, byFeature: real }`,
transports `{ restController: real, webflux?: stub }`, runtimes
`{ transactional: real }`; `adapterDefaults()`:
`{ persistence: { state: "jpa", eventLog: "axon" }, style: "layered", layout: "byFeature", transport: "restController", runtime: "transactional" }`.

## Generated-project shape (for one deployable `shop`)

```
shop-java/
  build.gradle.kts             Dockerfile (multi-stage gradle build)
  settings.gradle.kts
  src/main/resources/application.yml
  src/main/resources/db/migration/V1__init.sql        ← MigrationsIR → sql-pg
  src/main/resources/static/                          ← fullstack SPA mount
  src/main/java/<base>/Application.java
  src/main/java/<base>/<module>/domain/…              ← aggregates, parts, VOs,
  src/main/java/<base>/<module>/application/…            events, criteria specs
  src/main/java/<base>/<module>/infrastructure/…      ← JPA repos, config
  src/main/java/<base>/<module>/api/…                 ← controllers, DTOs, advice
  src/test/java/…                                     ← JUnit from `test "name"`
```
(`byFeature` layout regroups the same files per-aggregate; `byLayer` shown.)

---

## Slices

Each slice: implement → tests green (`npm test` + the named targeted suites) →
commit. JDK 21 + Gradle are available in the dev environment, so generated-code
compilation is verified locally from Slice 4 onward, not just in CI.

### S0 — This plan document
Commit the plan. *(Exit: doc pushed.)*

### S1 — Platform wiring + walking skeleton
- All wiring-map rows above (grammar regen committed; registry; surface;
  validator messages; likec4; the `"elixir"` branch sweep).
- `src/generator/java/index.ts` minimal: emits `build.gradle.kts` / `settings.gradle.kts`, `Application.java`,
  `application.yml`, health/ready endpoints, Dockerfile; `composeService` wired.
- Tests: registry resolution (`java`, `"java@v1"`, bad-version error), surface
  contract, skeleton snapshot, parse test for `platform: java`.
- *Exit:* `ddd generate system` on a java-deployable `.ddd` produces a project
  + compose entry; `npm test` green; skeleton `mvn -q compile` passes locally.

### S2 — Expression & statement renderers
- `src/generator/java/render-expr.ts`: `JAVA_TARGET` leaf table (all 17
  `ExprTarget` methods) + `JavaRenderContext` + import-collection helper
  (the `collectCsExprUsings` analog). Collection ops → Streams; `match` →
  switch expressions; money arithmetic; regex via `Pattern`; `refColl.contains`
  membership per the join-entity strategy.
- `src/generator/java/render-stmt.ts`: flat dispatch, 12 `StmtIR` kinds
  (preconditions → `DomainException`, `requires` → `ForbiddenException`,
  emit → `domainEvents.add(…)`, exception-less `return` variants).
- Tests: `test/generator/java/render-expr-kinds.test.ts` (per-kind arms, the
  dotnet mirror), render-stmt coverage.
- *Exit:* `npm test` green.

### S3 — Domain layer
- `emit/`: ids, enums, value objects (records + invariant ctor), events
  (records, `@DomainEvent`), entity.ts (aggregate roots + parts: private state,
  factory, operations with preconditions/mutations/emits, invariants, derived,
  private functions, access modifiers), `DomainException`/`ForbiddenException`,
  jMolecules stamping throughout.
- Tests: domain snapshot suite (`generator-java.test.ts` seed, mirroring the
  Order/Product fixtures), access-modifiers, nested-VO tests.
- *Exit:* `npm test` green.

### S4 — Persistence (JPA real) + migrations + seeding
- JPA mapping (annotations on entities or a separate mapping config —
  decided here for containments/VOs: `@Embedded`/`@ElementCollection`/owned
  one-to-many with cascade, the OwnsOne/OwnsMany analog), join entities for
  `X id[]` (+ ordinal column + diff-sync on save), Spring Data repository
  interfaces + impl finds (typed find-filter `ExprIR` → JPQL `@Query` /
  Criteria), auto-`findAll`/`getById` from the enrichment, datasource-schema
  split, seeding (first-boot data), migrations: `MigrationsIR` →
  `V<N>__*.sql` via `sql-pg.ts` + `flyway-core` wiring in `build.gradle.kts`/config.
- Adapters made real: `jpa` persistence, `layered` style, `byLayer`/`byFeature`
  layouts; stubs registered for `jooq`/`axon`/`cqrs`.
- New opt-in build suite: `test/e2e/generated-java-build.test.ts`
  (`LOOM_JAVA_BUILD=1`, `mvn -q -DskipTests package` per fixture) + npm script
  `test:java`. Run locally from here on every slice.
- Tests: migrations-emit, seed, datasource-schema, repository/find snapshots.
- *Exit:* `npm test` green; `npm run test:java` green locally on showcase.

### S5 — API layer + wire parity
- Controllers (`@RestController`, layered services), request/response DTOs +
  mapping generated from `wireShape` (`@JsonPropertyOrder`), error advice
  (status/envelope parity with .NET), validator classes, paged/envelope
  carriers, discriminated unions (sealed interfaces + tagged `type`),
  auth (JWT decode + `CurrentUser` accessor + `requires` threading),
  capabilities (filter/stamp/implements), request logging, SpringDoc OpenAPI,
  Jackson config (ISO datetimes, BigDecimal, ordering).
- Honest gates land here with .NET-matching codes (provenanced, per-op audited).
- Tests: wire-conformance, union-emit, paged-emit, capability,
  validation-error-extension, destroy-route mirrors.
- *Exit:* `npm test` + `test:java` green; OpenAPI spec served and shaped.

### S6 — Advanced domain
- TPC/TPH inheritance (sealed base classes; TPH discriminator column; only now
  add java to `isTphCapable` in `src/system/index.ts`), event sourcing
  (`persistedAs(eventLog)`: append-only events table + `apply` folds +
  rehydrator, on JPA), `shape(document)` JSONB persistence, reified criteria →
  **Spring Data `Specification<T>`** factories (first-class consumer of the
  shipped selectability model; inline criterion use-sites re-lowered like every
  backend), retrievals (named queries + `Specification` composition + paging),
  context filters (AND-ed into reads — Hibernate `@Filter` or spec
  composition, matching .NET's `HasQueryFilter` semantics incl. principal
  filters), resource ops (S3/Stripe-style static helper clients) + extern
  hooks.
- Tests: tph, eventsourced-emission, document-emission, criteria-emit,
  retrieval-emit, resource-ops mirrors.
- *Exit:* `npm test` + `test:java` green across `examples/*.ddd`.

### S7 — Workflows, views, test emission, observability, fullstack
- Workflows + workflow state machines + instances; views (read-only snapshots)
  + workflow views; `test "name"` → JUnit 5 classes; `test e2e … against
  <java-deployable>` confirmed lowering to vitest+fetch (platform-neutral path
  — expected free, verified by test); observability: structured-JSON stdout
  envelope (`server_starting` → … → `server_drained`, request spans) matching
  the catalog the obs-e2e suites assert; fullstack `ui:` mount (React SPA into
  `static/` + SPA fallback, the dotnet ClientApp analog).
- New opt-in suite: `test/e2e/observability-events-java.test.ts`
  (`LOOM_OBS_E2E_JAVA=1`) + npm script `test:obs-java`.
- Tests: workflow-instances, workflow-view, java-fullstack (platform test),
  generated-tests snapshot.
- *Exit:* `npm test`, `test:java`, `test:obs-java` green locally.

### S8 — System conformance integration — **DONE**
- `examples/showcase.ddd` ships a `javaApi` deployable (Catalog/Builds/People,
  `auth: required`, port 8081); `test/e2e/e2e.test.ts` boots it as the 5th
  compose service (`java_api`) in the strict cross-backend OpenAPI parity
  diff under `LOOM_E2E_STRICT_PARITY` — five backends, ten pairwise
  comparisons, plus the 403 runtime-authorization parity.  `conformance-parity.yml`
  runs the live 5-way diff on docker (timeout bumped 45→60 for the cold
  java image build).
- *Verified:* showcase java project gradle-compiles + boots, serves a 20-path
  springdoc spec matching the cross-backend route contract; the openapi
  normalizer already strips java's `/health` `/ready` `/openapi.json` probes.

### S9 — CI + docs + closure
- Workflows: `java-build.yml` (mirror `dotnet-build.yml`: setup-java 21 +
  maven cache keyed on the pom template + `npm run test:java`),
  `java-obs-e2e.yml` (main-only, mirror dotnet's), add java paths to
  `conformance-parity.yml` triggers (and bump its timeout if maven cold-start
  needs it).
- Docs: `generators.md` Java column, `platforms.md` registry row,
  `platform-parity-debt.md` matrix column, proposal status flip
  (VISION → SHIPPED, pointing here), `CLAUDE.md` (commands, generator table,
  CI surface), `docs/tools.md` CLI mention, `experience_gathered.md` entry for
  Java-specific gotchas found en route.
- Final full pass: `npm test`, `npm run lint`, `test:java`, `test:obs-java`,
  local conformance run.
- *Exit:* everything green; branch pushed.

## Risks / watch-list

1. **Wire parity is the time sink** (proposal's prediction; conformance is a
   per-PR gate). Mitigation: parity ground rules above are implemented as the
   *first* part of S5, and the wire-conformance test lands with the DTOs.
2. **Jackson defaults fight the contract** (timestamps, property order,
   BigDecimal). All serialization config is centralized in one generated
   `JacksonConfig` so fixes are single-file.
3. **JPA owned-collection semantics** (orphan removal, ordering, lazy-load on
   wire mapping) vs. .NET's OwnsMany — decided in S4 with build-verified
   fixtures, not discovered in conformance.
4. **Maven cold-start in CI** — cache `~/.m2` keyed on the pom template
   (the NuGet-cache precedent); keep generated dep list minimal and pinned.
5. **Event sourcing on JPA** has no Marten-equivalent library in scope —
   append-only table + fold (the exact .NET EF approach), not Axon; `axon`
   stays a stub adapter.
6. **Per-platform branch sweep**: any `platform === "elixir" | "dotnet"`
   conditional missed in S1 surfaces as a runtime gap later — the S1 grep
   sweep plus the conformance harness are the two nets.
