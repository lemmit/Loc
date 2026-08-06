// problem_variant/5 — emitted iff called.
//
// The shared error-variant responder is a PRIVATE fn in each generated
// controller, and the generated projects compile under
// `mix compile --warnings-as-errors` — an emitted-but-uncalled copy is a
// COMPILE FAILURE of the generated code, invisible to every string assertion
// that only looks for the def.  The old gate was a declarative predicate
// (has-returning-op-error || has-union-find) that drifted from the render
// sites the moment the find-absence arms moved to the token producer:
// `api-call`'s and `projection-groupby`'s controllers shipped the helper with
// zero callers and their corpus-elixir cells went red (#2448).  The gate is
// now DERIVED from the assembled controller sections (api-emit.ts,
// eventsourced-emit.ts), which cannot drift.
//
// This pin asserts the implication BOTH ways across representative fixtures:
// a controller that defines `problem_variant/5` must call it, and one whose
// ops declare mapped error variants still gets helper + caller together.
// Mutation-proven: restoring the old declarative gate in api-emit.ts fails
// the api-call case with "defines problem_variant/5 but never calls it".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const CORPUS = join(import.meta.dirname, "..", "..", "fixtures", "corpus");

function elixirSource(fixture: string): string {
  return readFileSync(join(CORPUS, `${fixture}.ddd`), "utf8").replace(/__PLATFORM__/g, "elixir");
}

async function controllers(fixture: string): Promise<Map<string, string>> {
  const files = await generateSystemFiles(elixirSource(fixture));
  const out = new Map<string, string>();
  for (const [path, content] of files) {
    if (path.endsWith("_controller.ex")) out.set(path, content);
  }
  expect(out.size, `${fixture} emitted no controllers`).toBeGreaterThan(0);
  return out;
}

describe("elixir controllers: problem_variant/5 is emitted iff called", () => {
  // The two fixtures whose corpus-elixir cells caught the unused copy (#2448).
  for (const fixture of ["api-call", "projection-groupby"]) {
    it(`${fixture}: no controller defines the helper without calling it`, async () => {
      for (const [path, ex] of await controllers(fixture)) {
        const defines = ex.includes("defp problem_variant(");
        // Strip the definition head BEFORE looking for callers — the def line
        // itself contains `problem_variant(conn`, so an unstripped regex is
        // satisfied by the very thing it must prove is referenced (the same
        // weak-pin shape this PR's parity tests were fixed for — caught, like
        // those, by the mutation run: the always-emit mutation passed this
        // pin's first draft).
        const body = ex.replace(/defp problem_variant\(conn[^\n]*/g, "");
        const calls = /problem_variant\(conn/.test(body);
        expect(
          !defines || calls,
          `${path} defines problem_variant/5 but never calls it — ` +
            `unused private fn, a --warnings-as-errors compile failure`,
        ).toBe(true);
      }
    });
  }

  // Same drifted-gate class, next helper: __truncate_dt/1 shipped unused into
  // projection-groupby's CONTEXT module (the declarative "any op assigns a
  // datetime" gate over-approximated the returning-op persist path that calls
  // it).  Same implication, same stripping rule.
  for (const fixture of ["projection-groupby", "scaffold-macros"]) {
    it(`${fixture}: no context module defines __truncate_dt without calling it`, async () => {
      const files = await generateSystemFiles(elixirSource(fixture));
      for (const [path, ex] of files) {
        if (!path.endsWith(".ex") || !ex.includes("defp __truncate_dt(")) continue;
        const body = ex.replace(/defp __truncate_dt\([^\n]*/g, "");
        expect(
          /__truncate_dt\(/.test(body),
          `${path} defines __truncate_dt/1 but never calls it`,
        ).toBe(true);
      }
    });
  }

  it("operation-returns: a mapped error variant still gets helper AND caller", async () => {
    // The positive control — without it, a gate that simply never emits the
    // helper would pass the implication vacuously.
    const all = [...(await controllers("operation-returns")).values()].join("\n");
    expect(all).toContain("defp problem_variant(");
    expect(all).toMatch(/problem_variant\(conn/);
  });
});
