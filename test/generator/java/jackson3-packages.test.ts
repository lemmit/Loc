import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// M-T9.24 E2 — the Jackson 2 → 3 migration, made unforgettable.
//
// Jackson 3 moved `com.fasterxml.jackson.databind` → `tools.jackson.databind`
// and `com.fasterxml.jackson.core` → `tools.jackson.core`.  It deliberately
// KEPT `com.fasterxml.jackson.annotation` (jackson-annotations did not change
// coordinates), so annotation imports are correct as-is and are NOT scanned.
//
// The migration was done emitter-by-emitter and stalled at 3 of 21 references
// for eleven days.  It stayed invisible because the emitted `build.gradle`
// depends on springdoc unconditionally, and springdoc drags swagger-core —
// which is still on Jackson 2 — onto every generated project's classpath.  So
// a stale `com.fasterxml.jackson.databind.ObjectMapper` COMPILED; it just
// serialized the outbox through a different mapper than the rest of the app.
// No compile gate could catch that, which is why this is a source-level scan.
//
// ONE reference is legitimate and pinned below: swagger-core's own
// `Json.mapper()` is a Jackson-2 `ObjectMapper`, so its `readValue` throws
// Jackson 2's CHECKED `JsonProcessingException`.  Catching Jackson 3's
// unchecked `JacksonException` there would not compile.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const JAVA_GEN = path.resolve(here, "../../../src/generator/java");

/** Jackson-2 packages that MUST NOT appear in emitted Java. */
const JACKSON_2 = /com\.fasterxml\.jackson\.(databind|core)\b/g;

/** file → the only Jackson-2 references allowed there, each with its reason. */
const ALLOWED = new Map<string, { ref: string; why: string }[]>([
  [
    "emit/openapi-customizer.ts",
    [
      {
        ref: "com.fasterxml.jackson.core.JsonProcessingException",
        why: "swagger-core's io.swagger.v3.core.util.Json.mapper() is a Jackson-2 ObjectMapper; its readValue throws Jackson 2's CHECKED JsonProcessingException, which this catch must name to compile.",
      },
    ],
  ],
]);

function tsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) return tsFilesUnder(full);
    return d.isFile() && full.endsWith(".ts") ? [full] : [];
  });
}

describe("java emitters are on Jackson 3", () => {
  it("references no Jackson-2 databind/core package outside the pinned exception", () => {
    const offenders: string[] = [];
    for (const file of tsFilesUnder(JAVA_GEN)) {
      const rel = path.relative(JAVA_GEN, file).replaceAll(path.sep, "/");
      const allowed = (ALLOWED.get(rel) ?? []).map((a) => a.ref);
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!JACKSON_2.test(line)) return;
        JACKSON_2.lastIndex = 0;
        if (allowed.some((ref) => line.includes(ref))) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `Jackson-2 package(s) in the Java emitters — Jackson 3 spells these \`tools.jackson.*\`.\n` +
        `A stale reference still COMPILES (springdoc drags swagger-core's Jackson 2 onto the\n` +
        `classpath), so nothing else will catch it.  If the reference is genuinely required —\n` +
        `interop with a Jackson-2 library — add it to ALLOWED with the reason.\n\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });

  it("keeps every pinned exception real (no stale allowlist entries)", () => {
    for (const [rel, entries] of ALLOWED) {
      const src = fs.readFileSync(path.join(JAVA_GEN, rel), "utf8");
      for (const { ref } of entries) {
        expect(src, `${rel} no longer contains pinned reference ${ref} — drop the entry`).toContain(
          ref,
        );
      }
    }
  });
});
