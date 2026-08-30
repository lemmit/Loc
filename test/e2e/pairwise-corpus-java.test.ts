import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describeCompileLeg, proxyCaDockerArgs } from "../pairwise/compile-leg.js";

// ---------------------------------------------------------------------------
// M-T9.29 — the COMPILE oracle, java leg (Spring Boot / JPA, `gradle`).
//
// Sibling of `pairwise-corpus-tsc.test.ts` (node); see `compile-leg.ts` for the
// shared contract and the motivating bug class. This leg supplies only java's
// toolchain: the generated projects target Java 25 (Gradle 9.1+), which this
// sandbox's host JDK 21 / Gradle 8.14 cannot build, so `compile` shells out to
// `docker run … gradle:9-jdk25 …` — the SAME image `corpus-java-build.test.ts`
// and `api-call-e2e.test.ts` build against, with a persistent gradle-home cache
// mounted across cases so a ~25-case pairwise cover doesn't pay a cold
// dependency download per case.
// ---------------------------------------------------------------------------

const JAVA_IMAGE = "gradle:9-jdk25";

/** Shared across every case in this run — a case differs in domain shape, not
 *  in Gradle/Spring/JPA dependency coordinates, so one warm `.gradle` cache
 *  serves the whole cover. Persisted under the OS tmp dir (not a per-run
 *  mkdtemp) so a re-run of a single shard via LOOM_PAIRWISE_COMPILE_CASE also
 *  benefits from a previous run's downloads. */
const GRADLE_HOME = path.join(os.tmpdir(), "loom-pairwise-java-gradle-home");
fs.mkdirSync(GRADLE_HOME, { recursive: true });

/** Proxy + CA plumbing the container needs to reach Maven Central in this
 *  environment, and NOTHING extra on a CI runner.
 *
 *  `-e NAME` with no `=value` passes through whatever the host has (or nothing),
 *  so the proxy vars and `JAVA_TOOL_OPTIONS` (which points the JVM at the
 *  sandbox truststore) are inert where they are unset.  The CA mount is NOT
 *  inert and is therefore conditional — see `proxyCaDockerArgs`, added after the
 *  dotnet leg's unconditional copy of the same sandbox-only file failed every
 *  case on the runner. */
const PROXY_ENV = [
  "-e",
  "HTTPS_PROXY",
  "-e",
  "HTTP_PROXY",
  "-e",
  "JAVA_TOOL_OPTIONS",
  ...proxyCaDockerArgs(),
];

describeCompileLeg({
  platform: "java",
  label: "java",
  enabled: process.env.LOOM_PAIRWISE === "1" && process.env.LOOM_JAVA_BUILD === "1",
  projectDir: (root) => path.join(root, "d"),
  compile(proj) {
    const args = [
      "run",
      "--rm",
      "--network",
      "host",
      "-v",
      `${proj}:/src`,
      "-w",
      "/src",
      "-v",
      `${GRADLE_HOME}:/home/gradle/.gradle`,
      ...PROXY_ENV,
      JAVA_IMAGE,
      "gradle",
      "--no-daemon",
      "testClasses",
      "bootJar",
    ];
    try {
      execSync(`docker ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
        stdio: "pipe",
        timeout: 600_000,
      });
      return undefined;
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer };
      return `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`;
    }
  },
  timeoutMs: 660_000,
});
