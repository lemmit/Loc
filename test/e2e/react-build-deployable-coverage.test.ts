// Every React deployable an example emits must be in the compile gate's input
// set — not just the first one (field-test finding B2).
//
// `generated-react-build.test.ts` compiles ONE project per example (`reactDir`)
// plus a hand-maintained `extraReactDirs` list.  A hand-maintained list is a
// silent-skip machine: `examples/showcase.ddd` declares THREE frontend
// deployables (consoleWeb / opsWeb / adminWeb) and the case named two, so
// `ops_web` — a whole generated React app — was never type-checked by anything.
// The same failure already happened once with `admin_web`, whose own case
// comment records the off-wire-field bug that shipped "precisely because the
// gate only ever compiled the FIRST deployable per example".
//
// So derive the truth instead of trusting the list: generate each example and
// assert the case names every React project root the generator actually wrote.
// Pure generation, no npm install and no compiler, so this runs per-PR in the
// fast suite while the compile sweep it guards runs on `push: main`.
//
// This is a COVERAGE guard, not a type check — it proves the compile gate is
// pointed at every emitted app, not that those apps compile.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";
import { reactBuildExamples } from "./react-build-cases.js";

/** A React project root, as the emitted tree names it: the directory holding
 *  `src/main.tsx` (the Vite entry every React deployable emits). */
const REACT_ENTRY = /^(.+)\/src\/main\.tsx$/;

function reactProjectDirs(files: ReadonlyMap<string, string>): string[] {
  const dirs = new Set<string>();
  for (const p of files.keys()) {
    const m = REACT_ENTRY.exec(p);
    if (m?.[1]) dirs.add(m[1]);
  }
  return [...dirs].sort();
}

describe("React build cases cover every React deployable their example emits", () => {
  for (const example of reactBuildExamples) {
    it(`${example.ddd}: no emitted React app is left out of the compile gate`, async () => {
      const files = await generateSystemFiles(readFileSync(example.ddd, "utf8"));
      const emitted = reactProjectDirs(files);

      // Floor: an example that emitted no React app at all would make the
      // comparison below trivially satisfiable in the wrong direction.
      expect(emitted.length, `${example.ddd} emitted no React project`).toBeGreaterThan(0);

      const covered = [example.reactDir, ...(example.extraReactDirs ?? [])].sort();
      expect(
        covered,
        `${example.ddd} emits React apps [${emitted.join(", ")}] but the build case only ` +
          `compiles [${covered.join(", ")}].  Add the missing dir(s) to \`extraReactDirs\` ` +
          `in test/e2e/react-build-cases.ts, or that app ships without ever being ` +
          `type-checked.`,
      ).toEqual(emitted);
    }, 120_000);
  }

  // Non-vacuity: at least one case must actually exercise the multi-deployable
  // path, or the whole suite would pass on a generator that emitted one app per
  // example and the guard would never have bitten.
  it("at least one case covers an example with several React deployables", () => {
    const multi = reactBuildExamples.filter((e) => (e.extraReactDirs?.length ?? 0) > 0);
    expect(
      multi.map((e) => e.ddd),
      "no case lists extraReactDirs — the multi-deployable path is untested",
    ).not.toEqual([]);
  });
});
