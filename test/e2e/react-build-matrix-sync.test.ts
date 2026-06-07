import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { reactBuildExamples } from "./react-build-cases.js";

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
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

describe("React build: CI matrix ↔ examples list stay in sync", () => {
  it("workflow EXAMPLES matches the test's example set", () => {
    const wf = fs.readFileSync(
      path.join(repoRoot, ".github", "workflows", "generated-react-build.yml"),
      "utf-8",
    );
    // The workflow declares EXAMPLES twice (the slim PR slice and the
    // full push:main Cartesian).  Pick the longest array — the full set.
    const arrays = [...wf.matchAll(/EXAMPLES='(\[[^\]]*\])'/g)].map(
      (m) => JSON.parse(m[1]) as string[],
    );
    expect(arrays.length).toBeGreaterThan(0);
    const workflowExamples = arrays.reduce((a, b) => (b.length > a.length ? b : a));
    const testExamples = reactBuildExamples.map((e) => e.ddd);
    expect([...workflowExamples].sort()).toEqual([...testExamples].sort());
  });
});
