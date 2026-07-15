import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORPUS_DEPLOYABLE, materializeCorpusFixture } from "../fixtures/corpus/harness.js";
import { CORPUS } from "../fixtures/corpus/manifest.js";

// ---------------------------------------------------------------------------
// Phase 1 compile tier (docs/old/plans/global-test-coverage-plan.md) for the Java
// (Spring Boot / JPA) backend — the sibling of `corpus-tsc-build.test.ts`.
// The fast `corpus-coverage` gate proves every corpus feature *generates* on
// `java`; this gate proves the emitted project actually *compiles* under
// `gradle testClasses bootJar` (main + emitted JUnit sources), upgrading the
// corpus from a generation floor to a compile guarantee on a SECOND backend,
// from the SAME single source of truth (one `.ddd` per feature, no per-backend
// duplicate).
//
// Slow (gradle dependency download + javac per feature) — opt-in via
// LOOM_JAVA_BUILD=1.  CI shards one feature per cell via
// LOOM_CORPUS_JAVA_CASE=<feature-id>.  Requires JDK 21 + Gradle ≥ 8 on PATH.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_JAVA_BUILD === "1";
const CASE = process.env.LOOM_CORPUS_JAVA_CASE;

// Features that GENERATE on java but don't yet compile under
// `gradle testClasses bootJar` — real Java generator gaps this compile tier
// surfaced (the generation gate still covers all of them on all six backends;
// each line is a precise, reproducible bug report).  Widen the gate by FIXING
// the emitter, then dropping the entry.
const JAVA_COMPILE_SKIP: Record<string, string> = {
  // (provenance: now emitted + gradle-clean on java — W2 — so it gates here.)
  // PLATFORM LIMITATION (generate-time error): a shape: embedded aggregate with a
  // reference-collection (`X id[]`) jsonb id-array column isn't mapped on java
  // (Hibernate's structured-JSON path bypasses the Jackson FormatMapper for
  // @Embeddable ids).  Documented; use shape: document/relational or host on
  // node/dotnet.
  embedded:
    "PLATFORM LIMITATION: jsonb id-array column unmapped on java (shape: embedded + ref collection)",
};

// Every corpus feature the manifest declares to generate on `java`, minus the
// documented compile-tier skips.
const javaFeatures = CORPUS.filter((f) => f.backends.includes("java"))
  .filter((f) => !(f.id in JAVA_COMPILE_SKIP))
  .filter((f) => !CASE || f.id === CASE)
  .map((f) => f.id);

describe.skipIf(!ENABLED)("corpus features compile under gradle (Java/Spring Boot)", () => {
  it.each(javaFeatures)("%s — generated java project compiles", (featureId) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-corpus-java-${featureId}-`));
    try {
      const src = materializeCorpusFixture(featureId, "java", outDir);
      execSync(`node ${cli} generate system ${src} -o ${outDir}`, {
        stdio: "inherit",
        cwd: repoRoot,
      });
      // The deployable is named `d` → its project lands under `d/`.
      const proj = path.join(outDir, CORPUS_DEPLOYABLE);
      expect(
        fs.existsSync(path.join(proj, "build.gradle")) ||
          fs.existsSync(path.join(proj, "build.gradle.kts")),
        `${featureId}: java project emitted`,
      ).toBe(true);
      execSync("gradle --no-daemon -q testClasses bootJar", {
        cwd: proj,
        stdio: "inherit",
        timeout: 600_000,
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 660_000);
});
