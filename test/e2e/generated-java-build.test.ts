import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";

// ---------------------------------------------------------------------------
// Generator regression test: emit each fixture via `ddd generate system`,
// then run `gradle testClasses bootJar` against the java deployable
// (compiles main + the emitted JUnit test sources, packages the boot jar).  Catches generator
// drift that breaks the generated Java (bad imports, JPA mapping shapes
// the annotation processor rejects, signature mismatches against Spring
// Data / Jackson) without booting the docker stack.
//
// Mirrors `generated-dotnet-build.test.ts`.  Slow (~60s cold per fixture,
// dominated by the Gradle dependency download; warm runs reuse ~/.gradle).
// Opt-in via LOOM_JAVA_BUILD=1 so the default `npm test` stays fast.
//
// Requires JDK 25 + Gradle ≥ 9.1 on PATH (matching the generated build's
// Java 25 toolchain — older Gradle rejects the toolchain version).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_JAVA_BUILD === "1";

/** fixture → the deployable folder (serviceSlug of the deployable name). */
const FIXTURES: Array<[string, string]> = [
  // Core domain shapes: enums, VOs (embedded records), events, containment
  // collections, derived sums over BigDecimal, declared finds → @Query JPQL,
  // Flyway migration emission.
  ["test/e2e/fixtures/java-build/domain.ddd", "shop_api"],
  // The full showcase surface on java, straight from the conformance
  // fixture (no fork — the showcase-java.ddd twin was retired once the
  // union-find variant-match rendered on the optional twin, #1631): auth
  // (user block + requires), extern operations, workflows incl.
  // variant-match, views, finds, value objects, money option/derived,
  // capability stamps, softDelete, seeding, event sourcing.
  ["examples/showcase.ddd", "java_api"],
  // Paged finds: Paged<T> envelope, Spring Data Pageable count derivation.
  ["test/e2e/fixtures/java-build/paged.ddd", "paged_api"],
  // Retrievals + reified criteria: Specification factories, the
  // JpaSpecificationExecutor path, composed-where @Query JPQL fallback,
  // workflow `Repo.run` + `for` loops.
  ["test/e2e/fixtures/java-build/retrieval.ddd", "crm_api"],
  // First-boot seeding: <Ctx>SeedRunner with domain + raw datasets and
  // the __loom_seed ship-once marker.
  ["test/e2e/fixtures/java-build/seeding.ddd", "seed_api"],
  // Single (non-collection) containment: hidden owning `_parent`
  // @OneToOne on the part, inverse mappedBy on the root, orphanRemoval.
  ["test/e2e/fixtures/java-build/single-containment.ddd", "sc_api"],
  // Exception-less operation returns: sealed domain union + Jackson
  // polymorphic wire DTO + controller ProblemDetail translation.
  ["test/e2e/fixtures/java-build/operation-returns.ddd", "ru_api"],
  // DEBT-15 / nested-parts: a part inside a part — Shipment contains a single
  // Label + a collection of Stickers.  Each nested part FKs to its DIRECT parent
  // (shipment_id), so the @OneToOne/@OneToMany join column matches the Flyway
  // DDL (was gated / boot-broken).  Verified end-to-end on Postgres.
  ["test/e2e/fixtures/java-build/nested-parts.ddd", "api"],
  // Capability filters: @SQLRestriction from the non-principal filter
  // predicate (softDelete pattern).
  ["test/e2e/fixtures/java-build/context-filter.ddd", "cf_api"],
  // §11.6 `ignoring` filter bypass: softDeletable promoted off @SQLRestriction to
  // a bypassable @FilterDef/@Filter, disabled per-read via the Hibernate Session
  // (disableFilter/enableFilter); the bare `filter price > 0` stays @SQLRestriction.
  // Compiles the @Filter machinery + EntityManager-unwrap bypass under Hibernate 7.x.
  ["test/e2e/fixtures/java-build/filter-bypass.ddd", "api"],
  // Principal (tenancy) capability filter: SpEL-principal JPQL clause
  // (`:#{@currentUserAccessor.user()?.tenantId()}`) AND-ed into the scoped
  // findAll/findById overrides + custom find + view, with the auth
  // (CurrentUserAccessor/UserFilter) the SpEL resolves through.
  ["test/e2e/fixtures/java-build/tenancy-filter.ddd", "api1"],
  // Tenancy filter AND-ed into a REIFIED criterion retrieval: the
  // `tenantScope(User)` Specification factory + injected CurrentUserAccessor
  // + `findAll(spec.and(tenantScope(...)))` (the JpaSpecificationExecutor path
  // the @Query overrides don't cover).
  ["test/e2e/fixtures/java-build/tenancy-reified.ddd", "api1"],
  // Multi-tenancy P2.2: HIERARCHY — the registry (`implements tenantRegistry`)
  // carries a `data_key` column, so `currentUser.orgPath` resolves to the
  // caller org's materialized path, read per request via the generated
  // OrgPathResolver (a JdbcTemplate `SELECT data_key … WHERE id = <claim>`
  // closure registered at boot), fail-safe to the claim.  A `with tenantOwned`
  // aggregate filters on `currentUser.orgPath` (the SpEL accessor use-site).
  ["test/e2e/fixtures/java-build/tenancy-hierarchy.ddd", "api1"],
  // DEBT-24 — a PRINCIPAL criterion used directly in a find/retrieval `where`.
  // java does not reify a principal criterion into a `Criteria` factory; it
  // routes to the inline JPA `@Query` binding the principal via the ambient
  // `@currentUserAccessor.user()?.tenantId()` SpEL (the .NET/Hono sibling case,
  // already correct on java) — a regression guard for the one-principal-source.
  ["test/e2e/fixtures/java-build/tenancy-retrieval.ddd", "api1"],
  // TPH (sharedTable) inheritance: JPA SINGLE_TABLE + @DiscriminatorColumn
  // on the abstract base, @DiscriminatorValue per concrete, shared <Base>Id.
  ["corpus:tph", CORPUS_DEPLOYABLE],
  // Embedded-SPA fullstack mount: /api route prefix, SpaWebConfig
  // (resource handler + index.html fallback), ClientApp/ React project.
  ["test/e2e/fixtures/java-build/fullstack.ddd", "fs_app"],
  // Union finds (`Order or NotFound` / `Order option`): optional-twin
  // repo/service, tagged 200 wire record, problem/bare-404 absence.
  ["test/e2e/fixtures/java-build/union-finds.ddd", "uf_api"],
  // Resource clients (objectStore / queue / api): S3 / RabbitMQ /
  // HttpClient classes + workflow resource-op call sites.
  ["test/e2e/fixtures/java-build/resources.ddd", "rc_api"],
  // Event sourcing (persistedAs: eventLog): JdbcTemplate stream
  // append + applier fold, no state table / Spring Data interface.
  ["test/e2e/fixtures/java-build/event-sourced.ddd", "es_api"],
  // State-based saga: a broadcast channel + a correlation-row workflow with
  // both a `create(...)` starter and an `on(...)` continuation reactor — the
  // plain (non-event-sourced) `@EventListener` handler path, each reactor
  // wrapping its body in a RequestContext.openChild() child frame.
  ["test/e2e/fixtures/java-build/saga.ddd", "api"],
  // Event-sourced workflow: append-only `<wf>_events` stream + fold-on-load
  // + emit→append-own-event dispatch (the saga analogue of event-sourced.ddd).
  ["corpus:eventsourced-workflow", CORPUS_DEPLOYABLE],
  // shape: document: whole aggregate in one jsonb column via the
  // field-visibility Jackson mapper, version-bumping upserts.
  ["test/e2e/fixtures/java-build/document.ddd", "doc_api"],
  // DEBT-02: a capability `filter` on a document aggregate — applied in-app
  // over the rehydrated aggregate (findById gate + findAll filter; custom finds
  // inherit via findAll().stream()).
  ["test/e2e/fixtures/java-build/document-filter.ddd", "api1"],
  // shape: embedded: containments fold into jsonb columns via the
  // Hibernate JSON FormatMapper; scalar columns stay queryable.
  ["test/e2e/fixtures/java-build/embedded.ddd", "emb_api"],
  // DEBT-02: a capability `filter` on an embedded aggregate — the root scalars
  // are real columns, so it rides @SQLRestriction (static SQL) on the root
  // entity, exactly like the relational path (no in-app filtering).
  ["test/e2e/fixtures/java-build/embedded-filter.ddd", "emb_api"],
  // DEBT-02 Slice A: a PRINCIPAL-referencing capability filter on an EMBEDDED
  // aggregate — the root scalars are real columns, so it reuses the
  // relational-principal path: the OrderJpaRepository gets scoped
  // findAll/findById overrides carrying a @Query with the SpEL clause
  // (`:#{@currentUserAccessor.user()?.tenantId()}`), under `auth: required`.
  // Previously gated by `loom.context-filter-unsupported`.
  ["test/e2e/fixtures/java-build/embedded-tenancy.ddd", "emb_api"],
  // DEBT-02 Slice B: a PRINCIPAL-referencing capability filter on a DOCUMENT
  // aggregate — the whole aggregate is one jsonb column, so the principal can't
  // ride @SQLRestriction; the document store injects a CurrentUserAccessor bean,
  // binds `var currentUser = currentUserAccessor.user();`, and applies the
  // fail-closed `currentUser != null && Objects.equals(...)` in-app predicate to
  // findById/findAll (custom finds inherit via findAll().stream()), under
  // `auth: required`.  Previously gated by `loom.context-filter-unsupported`.
  ["test/e2e/fixtures/java-build/document-tenancy.ddd", "api1"],
  // Lifecycle stamps (audit / softDelete): _stampOnCreate/_stampOnUpdate
  // entity methods the service calls before save (now() over a field).
  ["test/e2e/fixtures/java-build/stamps.ddd", "api1"],
  // Principal stamps: `createdBy := currentUser` → currentUser.id() (the
  // guid), threaded from the request-scoped accessor under auth.
  ["test/e2e/fixtures/java-build/stamps-principal.ddd", "api1"],
  // `with auditable` (built-in capability): its `createdBy/updatedBy: User id`
  // names the PRINCIPAL (no `aggregate User`), so it must lower to the
  // principal's id scalar (`user { id: guid }` → UUID), never a dangling
  // `UserId`.  Compiles the full audit-columns + create/update stamp bundle.
  ["test/e2e/fixtures/java-build/auditable.ddd", "api"],
  // Per-operation `audited` (audit-and-logging.md): an audited op persists a
  // who/what/when + before/after wire snapshot into `audit_records` INSIDE the
  // service's @Transactional method (the same txn as the aggregate save).
  ["test/e2e/fixtures/java-build/audited-operation.ddd", "api"],
  // `when` canCommand state gate (criterion.md, use site 2): the service
  // throws DisallowedException (→ 409) before mutating, and the controller
  // auto-exposes `GET /orders/{id}/can_cancel` → CanResponse { allowed }.
  ["test/e2e/fixtures/java-build/when.ddd", "when_api"],
  // Workflow with a value-object param + a bare int money-literal in the
  // factory-let: the workflow Request DTO + service import the VO's request
  // record (cross-package) and emit the `to<Vo>` mapper; `threshold: 0`
  // promotes to `new BigDecimal("0")` rather than a raw `int 0`.
  ["test/e2e/fixtures/java-build/workflow-vo-param.ddd", "wallet_api"],
  // M-T5.10 handler-param rewrite: `with scaffoldHandlers` synthesises explicit
  // commandHandler/queryHandlers taking a single `command`/`query` record param.
  // The Java `@Service handle(...)` FLATTENS the record's fields (byte-identical
  // to the flat-param form) and `cmd.<field>` reads the flat param; a read
  // declares `<Agg>Response` but the handler returns the entity (route projects
  // — single via `<Agg>Response.from(...)`, collection via `.stream().map(...)`).
  ["test/e2e/fixtures/java-build/scaffold-handlers.ddd", "api"],
  // OIDC turnkey auth (D-AUTH-OIDC): the generated @Primary OidcUserVerifier
  // (Nimbus JWKS + dotted-path claim mapping), the AuthController /auth/*
  // handshake + /auth/me probe, and the BOM-managed nimbus-jose-jwt dep.
  // Generated from the shared corpus fixture (one canonical auth-oidc across all backends).
  ["corpus:auth-oidc", CORPUS_DEPLOYABLE],
];

describe.skipIf(!ENABLED)(
  "generated Java project compiles under `gradle testClasses bootJar` (LOOM_JAVA_BUILD=1)",
  () => {
    it.each(FIXTURES)(
      "%s — `ddd generate system` output builds",
      (fixture, slug) => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-java-"));
        try {
          const src = fixture.startsWith("corpus:")
            ? materializeCorpusFixture(fixture.slice("corpus:".length), "java", outDir)
            : fixture;
          execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
            stdio: "inherit",
            cwd: repoRoot,
          });
          execSync(`gradle --no-daemon -q testClasses bootJar`, {
            cwd: path.join(outDir, slug),
            stdio: "inherit",
            timeout: 600_000,
          });
        } finally {
          fs.rmSync(outDir, { recursive: true, force: true });
        }
      },
      660_000,
    );

    // M10 phase 6b: the `injectSmap` task is Kotlin DSL emitted as a string
    // — vitest can never catch a syntax error in it, and every fixture above
    // generates flag-OFF, so without this case the emitted Gradle/ASM code
    // would only ever be proven by hand. Generate WITH --sourcemap, build,
    // and assert `javap -v` shows the SourceDebugExtension carrying the
    // Loom-stratum SMAP on the compiled aggregate class.
    it("--sourcemap: injectSmap attaches the JSR-45 SMAP (SourceDebugExtension via javap)", () => {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-java-smap-"));
      try {
        execSync(
          `node ${cli} generate system test/e2e/fixtures/java-build/domain.ddd -o ${outDir} --sourcemap`,
          { stdio: "inherit", cwd: repoRoot },
        );
        const projectDir = path.join(outDir, "shop_api");
        const smaps = execSync(`find src/main/java -name '*.smap'`, {
          cwd: projectDir,
          encoding: "utf8",
        })
          .trim()
          .split("\n")
          .filter(Boolean);
        if (smaps.length === 0) throw new Error("no .smap sidecars emitted under src/main/java");

        execSync(`gradle --no-daemon -q testClasses`, {
          cwd: projectDir,
          stdio: "inherit",
          timeout: 600_000,
        });

        // The first sidecar's class must carry the attribute.
        const rel = smaps[0]!
          .replace(/\.java\.smap$/, ".class")
          .replace(/^src\/main\/java\//, "build/classes/java/main/");
        const javap = execSync(`javap -v ${rel}`, { cwd: projectDir, encoding: "utf8" });
        if (!javap.includes("SourceDebugExtension")) {
          throw new Error(`javap shows no SourceDebugExtension on ${rel}`);
        }
        if (!javap.includes("*S Loom")) {
          throw new Error(`SourceDebugExtension on ${rel} carries no Loom stratum`);
        }
      } finally {
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }, 660_000);
  },
);
