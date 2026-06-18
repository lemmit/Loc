import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

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
// Requires JDK 21 + Gradle ≥ 8 on PATH (matching the generated build).
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
  // The full showcase surface on java: auth (user block + requires),
  // extern operations, workflows, both view forms, finds, value objects.
  ["test/e2e/fixtures/java-build/showcase-java.ddd", "dotnet_api"],
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
  // Capability filters: @SQLRestriction from the non-principal filter
  // predicate (softDelete pattern).
  ["test/e2e/fixtures/java-build/context-filter.ddd", "cf_api"],
  // TPH (sharedTable) inheritance: JPA SINGLE_TABLE + @DiscriminatorColumn
  // on the abstract base, @DiscriminatorValue per concrete, shared <Base>Id.
  ["test/e2e/fixtures/java-build/tph.ddd", "tph_api"],
  // Embedded-SPA fullstack mount: /api route prefix, SpaWebConfig
  // (resource handler + index.html fallback), ClientApp/ React project.
  ["test/e2e/fixtures/java-build/fullstack.ddd", "fs_app"],
  // Union finds (`Order or NotFound` / `Order option`): optional-twin
  // repo/service, tagged 200 wire record, problem/bare-404 absence.
  ["test/e2e/fixtures/java-build/union-finds.ddd", "uf_api"],
  // Resource clients (objectStore / queue / api): S3 / RabbitMQ /
  // HttpClient classes + workflow resource-op call sites.
  ["test/e2e/fixtures/java-build/resources.ddd", "rc_api"],
  // Event sourcing (persistedAs(eventLog)): JdbcTemplate stream
  // append + applier fold, no state table / Spring Data interface.
  ["test/e2e/fixtures/java-build/event-sourced.ddd", "es_api"],
  // Event-sourced workflow: append-only `<wf>_events` stream + fold-on-load
  // + emit→append-own-event dispatch (the saga analogue of event-sourced.ddd).
  ["test/e2e/fixtures/java-build/eventsourced-workflow.ddd", "eswf_api"],
  // shape(document): whole aggregate in one jsonb column via the
  // field-visibility Jackson mapper, version-bumping upserts.
  ["test/e2e/fixtures/java-build/document.ddd", "doc_api"],
  // shape(embedded): containments fold into jsonb columns via the
  // Hibernate JSON FormatMapper; scalar columns stay queryable.
  ["test/e2e/fixtures/java-build/embedded.ddd", "emb_api"],
  // Lifecycle stamps (audit / softDelete): _stampOnCreate/_stampOnUpdate
  // entity methods the service calls before save (now() over a field).
  ["test/e2e/fixtures/java-build/stamps.ddd", "api1"],
  // Principal stamps: `createdBy := currentUser` → currentUser.id() (the
  // guid), threaded from the request-scoped accessor under auth.
  ["test/e2e/fixtures/java-build/stamps-principal.ddd", "api1"],
  // `when` canCommand state gate (criterion.md, use site 2): the service
  // throws DisallowedException (→ 409) before mutating, and the controller
  // auto-exposes `GET /orders/{id}/can_cancel` → CanResponse { allowed }.
  ["test/e2e/fixtures/java-build/when.ddd", "when_api"],
  // OIDC turnkey auth (D-AUTH-OIDC): the generated @Primary OidcUserVerifier
  // (Nimbus JWKS + dotted-path claim mapping), the AuthController /auth/*
  // handshake + /auth/me probe, and the BOM-managed nimbus-jose-jwt dep.
  ["test/e2e/fixtures/java-build/auth-oidc.ddd", "api"],
];

describe.skipIf(!ENABLED)(
  "generated Java project compiles under `gradle testClasses bootJar` (LOOM_JAVA_BUILD=1)",
  () => {
    it.each(FIXTURES)(
      "%s — `ddd generate system` output builds",
      (fixture, slug) => {
        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-java-"));
        try {
          execSync(`node ${cli} generate system ${fixture} -o ${outDir}`, {
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
  },
);
