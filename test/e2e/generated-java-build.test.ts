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
