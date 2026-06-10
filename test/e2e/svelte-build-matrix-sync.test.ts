import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { svelteBuildExamples, sveltePacks } from "./svelte-build-cases.js";

// ---------------------------------------------------------------------------
// Drift guard — the svelte sibling of react-build-matrix-sync.test.ts.
// The CI matrix in .github/workflows/generated-svelte-build.yml
// hardcodes its example + pack arrays; the build harness drives shards
// from `svelteBuildExamples` × `sveltePacks`.  When the two drift, a
// shard's LOOM_SVELTE_BUILD_CASE matches no case and the workflow goes
// red on every shard.  Pin them here, in the fast suite.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

describe("Svelte build: CI matrix ↔ cases stay in sync", () => {
  it("workflow matrix matches the test's example + pack sets", () => {
    const wf = fs.readFileSync(
      path.join(repoRoot, ".github", "workflows", "generated-svelte-build.yml"),
      "utf-8",
    );
    const list = (key: "example" | "pack"): string[] => {
      const m = wf.match(new RegExp(`${key}: \\[([^\\]]*)\\]`));
      expect(m, `workflow matrix.${key} present`).toBeTruthy();
      return m![1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    };
    expect(list("example").sort()).toEqual([...svelteBuildExamples].sort());
    expect(list("pack").sort()).toEqual([...sveltePacks].sort());
  });
});
