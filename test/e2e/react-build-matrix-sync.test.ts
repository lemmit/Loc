import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reactBuildExamples, reactBuildPacks, reactPackId } from "./react-build-cases.js";

// ---------------------------------------------------------------------------
// Drift guard — pure string check, no build, so it runs in the fast
// `npm test` suite (unlike its sibling generated-react-build.test.ts,
// which is excluded).  The CI matrix in
// .github/workflows/generated-react-build.yml hardcodes its own
// `EXAMPLES` array; the build harness drives shards from
// `reactBuildExamples`.  When the two drift, the workflow feeds
// `LOOM_REACT_BUILD_CASE` shards the test can't match and every such
// shard dies with "did not match any case" — which is exactly how the
// whole React-build workflow went silently red (a multi-file example
// and a since-renamed one were left in the matrix but not the test set).
// Pin them so a future edit to either side fails here, fast, instead of
// at 3am on the nightly.
//
// The full sweep asks the harness for "every pack" per example (a bare
// `<ddd>` case), so there is no full pack list in the workflow to drift.
// The slim PR slice still names its two packs explicitly — those are
// pinned below against `reactBuildPacks`.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const wf = fs.readFileSync(
  path.join(repoRoot, ".github", "workflows", "generated-react-build.yml"),
  "utf-8",
);

/** Every `EXAMPLES='[…]'` / `PACKS='[…]'` array literal in the workflow. */
function shellArrays(name: string): string[][] {
  return [...wf.matchAll(new RegExp(`${name}='(\\[[^\\]]*\\])'`, "g"))].map(
    (m) => JSON.parse(m[1]) as string[],
  );
}

describe("React build: CI matrix ↔ examples list stay in sync", () => {
  it("workflow EXAMPLES matches the test's example set", () => {
    // The workflow declares EXAMPLES twice (the slim PR slice and the
    // full push:main sweep).  Pick the longest array — the full set.
    const arrays = shellArrays("EXAMPLES");
    expect(arrays.length).toBeGreaterThan(0);
    const workflowExamples = arrays.reduce((a, b) => (b.length > a.length ? b : a));
    const testExamples = reactBuildExamples.map((e) => e.ddd);
    expect([...workflowExamples].sort()).toEqual([...testExamples].sort());
  });

  it("every pack the workflow names is a pack the harness knows", () => {
    // A typo'd or retired pack id here would make that shard throw
    // "names unknown pack" at CI time instead of failing fast in the
    // unit suite.
    const known = new Set(reactBuildPacks.map(reactPackId));
    const named = shellArrays("PACKS").flat();
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((p) => !known.has(p))).toEqual([]);
  });

  it("the full sweep batches per example rather than enumerating packs", () => {
    // The full sweep's coverage is "all 8 packs" by construction — it
    // passes a bare `<ddd>` case.  If a future edit re-introduced a
    // per-pack Cartesian here it would silently double as a second,
    // drift-prone copy of `reactBuildPacks`; the assertion is that only
    // the slim PR slice (2 packs) names packs at all.
    for (const packs of shellArrays("PACKS")) {
      expect(packs.length).toBeLessThan(reactBuildPacks.length);
    }
    expect(wf).toContain("LOOM_REACT_BUILD_CASE: ${{ matrix.case }}");
  });
});
