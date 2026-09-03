// Reader census (M-T6.52) — every seed emitter consumes the SHARED seeder
// model (`src/generator/_persistence/seed-datasets.ts`) instead of
// re-deriving its own "which aggregates are seedable" / "what does this
// aggregate's create call need" logic.  That is exactly the shape the
// mission found broken: java's `groupByDataset` was a byte-for-byte LOCAL
// duplicate of the shared one, and three of five backends built an
// event-sourced aggregate's create-call args from `forCreateInput(agg.fields)`
// — the FIELD set — instead of the `create` action's own declared PARAMS.
//
// This is a STATIC source-text census, not a generator-output one: the
// defect it guards against (an emitter quietly re-deriving a field the model
// already carries) is invisible in emitted output whenever the re-derivation
// happens to agree with the model — which non-event-sourced fixtures always
// do, by construction (`seederAggregate`'s state branch returns exactly
// `createInputFields(agg)`).  Reading the emitter's own source is the only
// way to catch the SECOND copy of the derivation before it drifts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SEED_EMITTERS = [
  "src/generator/typescript/emit/seed.ts",
  "src/generator/dotnet/emit/seed.ts",
  "src/generator/python/emit/seed.ts",
  "src/generator/java/emit/seed.ts",
  "src/generator/elixir/vanilla/seed-emit.ts",
] as const;

/** file:line of the first match, or `null`. */
function findLine(src: string, re: RegExp): string | null {
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) return `:${i + 1}: ${lines[i]!.trim()}`;
  }
  return null;
}

describe("seed emitters — reader census (M-T6.52)", () => {
  for (const path of SEED_EMITTERS) {
    const src = readFileSync(path, "utf8");

    it(`${path} imports the shared dataset grouping, not a local copy`, () => {
      expect(
        /from\s+["'][./]*_persistence\/seed-datasets\.js["']/.test(src),
        `${path} does not import from _persistence/seed-datasets.js`,
      ).toBe(true);
      expect(/\bgroupByDataset\b/.test(src), `${path} never references groupByDataset`).toBe(true);
    });

    it(`${path} declares no LOCAL groupByDataset / Dataset / Entry (the java-duplicate class)`, () => {
      const dupFn = findLine(src, /^\s*function\s+groupByDataset\s*\(/);
      const dupIface = findLine(src, /^\s*interface\s+(Dataset|Entry)\s*\{/);
      expect(dupFn, `${path}${dupFn ?? ""} re-declares groupByDataset locally`).toBeNull();
      expect(
        dupIface,
        `${path}${dupIface ?? ""} re-declares a local Dataset/Entry shape`,
      ).toBeNull();
    });

    it(`${path} derives its seedable-aggregate set from the shared seeder model`, () => {
      expect(
        /\bseederAggregates?\b/.test(src),
        `${path} never references seederAggregate/seederAggregates — it is not consulting the shared model`,
      ).toBe(true);
    });

    it(`${path} does not re-derive create-input fields itself (forCreateInput / createInputFields)`, () => {
      // The shared model is the ONLY place `forCreateInput`/`createInputFields`
      // may be called to build a SEED create-call's field/param list — a seed
      // emitter importing either directly is re-deriving what
      // `seederAggregate` already computed (and, on an event-sourced
      // aggregate, deriving it WRONG — see the module doc above).
      const badImport = findLine(
        src,
        /import\s*\{[^}]*\b(forCreateInput|createInputFields)\b[^}]*\}\s*from/,
      );
      expect(
        badImport,
        `${path}${badImport ?? ""} imports forCreateInput/createInputFields directly — ` +
          "route the create-call field/param list through seederAggregate(s) instead",
      ).toBeNull();
    });
  }
});
