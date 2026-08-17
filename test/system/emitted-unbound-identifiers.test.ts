// The scope invariant, over the WHOLE react build matrix — not one fixture.
//
// `test/generator/_walker/pager-chrome-import.test.ts` (#2507) already states
// the right invariant, on a hand-written 30-line system.  That fixture pins the
// one shape #2507 fixed; it cannot see the NEXT primitive that forgets to
// register its import, in an example nobody thought to synthesise.
//
// The defect it was written for was found by `tsc`, on `push: main`, ten
// consecutive times.  The gap is not the invariant — it is the INPUT SET:
//
//   PR time    `examples/showcase.ddd` × 2 packs  =   2 cells   (compiled)
//   push:main  every example × every pack         = 160 cells   (compiled)
//
// This test closes that gap from the cheap side.  It generates the same 160
// cells the sweep compiles and asserts the scope invariant on all of them,
// per-PR, in the fast suite — because generation is ~294ms per cell while
// compilation is 60-90s.  The examples and packs are imported from
// `test/e2e/react-build-cases.ts`, the same constants the workflow's matrix is
// built from, so this cannot drift from what `push: main` actually compiles.
//
// Deliberately NOT a replacement for the compile sweep — see the header of
// `test/_helpers/emitted-scope.ts` for what a scope check cannot see.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FRONTEND_SCOPES,
  translatingPages,
  unboundTranslateCalls,
} from "../_helpers/emitted-scope.js";
import { generateSystemFiles } from "../_helpers/index.js";
import { reactBuildExamples, reactBuildPacks, reactPackId } from "../e2e/react-build-cases.js";

/** React page files, as the emitted tree names them.  Taken from the shared
 *  spec rather than re-spelled here, so the vue/svelte/angular matrices can
 *  reuse the same table when they get this sweep. */
const REACT_PAGES = (() => {
  const react = FRONTEND_SCOPES.find((f) => f.framework === "react");
  if (!react) throw new Error("FRONTEND_SCOPES lost its react entry");
  return react.pages;
})();

/** Rewrite the example's `design:` slot to the pack under test — the same
 *  in-place rewrite `generated-react-build.test.ts` performs, so a cell here
 *  means what the same cell means there.  Kept to the pinned quoted form so a
 *  cell tests a SPECIFIC pack version, not whatever the bareword resolves to
 *  today. */
function injectDesign(src: string, qualified: string): string {
  const existing = /(\bdesign:\s*)(?:"[^"]*"|\w+)/;
  return existing.test(src) ? src.replace(existing, `$1"${qualified}"`) : src;
}

describe("emitted pages never call `t(` without binding it — the full react matrix", () => {
  // One `it` per EXAMPLE (packs looped inside): 20 cases rather than 160 keeps
  // the reporter readable, while a failure still names the exact pack and file.
  for (const example of reactBuildExamples) {
    it(`${example.ddd}: every pack emits pages with \`t\` in scope`, async () => {
      const source = readFileSync(example.ddd, "utf8");
      const offenders: string[] = [];

      for (const pack of reactBuildPacks) {
        const id = reactPackId(pack);
        const files = await generateSystemFiles(injectDesign(source, id));

        // Per-cell floor: a cell that emitted nothing would contribute an
        // empty offender list and read as a pass.
        expect(files.size, `${example.ddd} × ${id}: generation emitted nothing`).toBeGreaterThan(0);

        offenders.push(...unboundTranslateCalls(files, REACT_PAGES).map((p) => `${id} → ${p}`));
      }

      expect(
        offenders,
        `${example.ddd}: page calls \`t(\` with no \`t\` in scope (TS2304 at compile time)`,
      ).toEqual([]);
    }, 120_000);
  }

  // NON-VACUITY, asserted once rather than per example.
  //
  // An example with i18n off emits no `t(` at all, so a green per-example case
  // does not by itself prove the sweep reached the translate runtime — and if
  // the walker stopped emitting `t(` everywhere, all 20 cases would still pass.
  // This anchors the whole sweep against the exact cell that was red on main
  // for ten consecutive sweeps: it must translate, and it must bind.
  it("the sweep actually reaches translated pages (else all 20 cases are vacuous)", async () => {
    const source = readFileSync("web/src/examples/expression-showcase.ddd", "utf8");
    const files = await generateSystemFiles(injectDesign(source, "mantine@v9"));
    const translating = translatingPages(files, REACT_PAGES);

    expect(
      translating,
      "expression-showcase emits no translated page — the sweep would pass vacuously",
    ).not.toEqual([]);
    expect(translating.some((p) => p.endsWith("product_list.tsx"))).toBe(true);
  }, 120_000);

  it("the matrix is the one push:main compiles", () => {
    expect(reactBuildExamples.length).toBeGreaterThan(10);
    expect(reactBuildPacks.length).toBeGreaterThan(1);
  });
});
