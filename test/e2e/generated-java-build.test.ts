import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// Generator regression test: emit each fixture via `ddd generate system`,
// then run `mvn package` against the java deployable.  Catches generator
// drift that breaks the generated Java (bad imports, JPA mapping shapes
// the annotation processor rejects, signature mismatches against Spring
// Data / Jackson) without booting the docker stack.
//
// Mirrors `generated-dotnet-build.test.ts`.  Slow (~60s cold per fixture,
// dominated by the Maven dependency download; warm runs reuse ~/.m2).
// Opt-in via LOOM_JAVA_BUILD=1 so the default `npm test` stays fast.
//
// Requires JDK 21 + Maven on PATH (matching the generated pom).
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
];

describe.skipIf(!ENABLED)(
  "generated Java project compiles under `mvn package` (LOOM_JAVA_BUILD=1)",
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
          execSync(`mvn -q -B -DskipTests package`, {
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
