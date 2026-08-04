// A negative assertion on a file that was never emitted passes for free.
//
// The shape:
//
//     const reads = files.get("web/lib/reads.dart") ?? "";
//     expect(reads).not.toContain("class LoomPage<T>");
//
// If the emitter never produced that path, `?? ""` makes the assertion
// vacuously true.  It shipped exactly like that (#2384) and spent its whole life
// passing for the wrong reason, hiding a dangling Flutter `reads.dart` import
// underneath.  The suite that carried it ALREADY had the warning written in a
// comment — one call site in the same file did it anyway.  A comment is not a
// gate.
//
// The discriminator is not "does the file exist" (this test can't run the
// emitters) but "does anything in the suite PROVE it exists".  A variable bound
// through `?? ""` and asserted ONLY negatively has no such proof.  Pair it with
// a positive assertion (`toContain` / `toMatch` / `toHaveLength` / `toBeTruthy`)
// or fetch it with `expectEmitted` (test/_helpers/emitted.ts), which throws when
// the path is missing.
//
// The tree is currently at ZERO, so this is a zero-tolerance gate rather than a
// ratcheting allowlist — there is nothing legacy to grandfather.  If a genuinely
// intentional case ever appears (asserting a file's ABSENCE), express it as
// `expect(files.has(p)).toBe(false)`, which says so directly and is not matched
// here.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testRoot = join(fileURLToPath(new URL("../", import.meta.url)));

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      // `fixtures/` is excluded from vitest discovery (vitest.config.ts) — the
      // `.test.ts` files in there are captured generator OUTPUT, not this
      // project's test surface.
      if (entry !== "fixtures" && entry !== "node_modules") testFiles(p, out);
    } else if (p.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

/** Variables bound to a `<map>.get(...) ?? ""` fallback. */
const BOUND = /(?:const|let)\s+(\w+)\s*(?::[^=]+)?=\s*[^;\n]*\.get\([^)]*\)\s*\?\?\s*""/g;
/** `expect(v).not.toContain(...)` — optionally with a message argument. */
const NEGATIVE = /expect\(\s*(\w+)\s*(?:,[^()]*)?\)\s*\.not\.toContain/gs;
/** Any assertion that proves the content is non-empty. */
const POSITIVE =
  /expect\(\s*(\w+)\s*(?:,[^()]*)?\)\s*\.(?!not\.)(?:toContain|toMatch|toBeTruthy|toHaveLength)/gs;

function unprovenNegatives(src: string): string[] {
  const bound = new Set([...src.matchAll(BOUND)].map((m) => m[1] as string));
  if (bound.size === 0) return [];
  const negative = new Set(
    [...src.matchAll(NEGATIVE)].map((m) => m[1] as string).filter((v) => bound.has(v)),
  );
  const positive = new Set(
    [...src.matchAll(POSITIVE)].map((m) => m[1] as string).filter((v) => bound.has(v)),
  );
  return [...negative].filter((v) => !positive.has(v)).sort();
}

describe("no vacuous negative assertions on emitted files", () => {
  it('every `?? ""` binding asserted negatively also has proof the file exists', () => {
    const offenders: string[] = [];
    for (const f of testFiles(testRoot)) {
      // Skip self: the detector-pinning test below embeds the offending shape
      // as string fixtures, which is exactly what this scan looks for.
      if (f.endsWith("vacuous-file-assertion.test.ts")) continue;
      for (const v of unprovenNegatives(readFileSync(f, "utf8"))) {
        offenders.push(`${f.slice(f.indexOf("/test/") + 1)}: \`${v}\``);
      }
    }
    expect(
      offenders,
      'These variables come from `<map>.get(...) ?? ""` and are asserted ONLY with ' +
        "`.not.toContain`, so they pass even when the file was never emitted. Add a " +
        "positive assertion, or fetch with `expectEmitted` (test/_helpers/emitted.ts).",
    ).toEqual([]);
  });

  // The detector is the whole value here, so it is itself pinned: a regex that
  // silently stops matching would turn this gate into a no-op that always
  // reports zero — the very failure mode it exists to prevent.
  it("the detector catches the shape it is meant to catch", () => {
    const positive = `
      const reads = files.get("web/lib/reads.dart") ?? "";
      expect(reads).not.toContain("class LoomPage<T>");`;
    const withMessage = `
      const src = files.get("x.ts") ?? "";
      expect(src, "why").not.toContain("foo");`;
    const provenByPositive = `
      const page = files.get("p.dart") ?? "";
      expect(page).toContain("productNamed.isEmpty");
      expect(page).not.toContain("productNamed.items");`;
    const unrelated = `
      const ok = files.get("y.ts") ?? "";
      expect(ok).toContain("bar");`;

    expect(unprovenNegatives(positive)).toEqual(["reads"]);
    expect(unprovenNegatives(withMessage)).toEqual(["src"]);
    // A positive assertion on the SAME variable proves the file is there, so a
    // negative alongside it is meaningful — not an offender.
    expect(unprovenNegatives(provenByPositive)).toEqual([]);
    expect(unprovenNegatives(unrelated)).toEqual([]);
  });
});
