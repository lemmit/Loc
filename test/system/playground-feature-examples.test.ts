import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerProject } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { loadProject } from "../../src/language/project-loader.js";
import { generateSystemsFromLoom } from "../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// The "feature showcase" playground examples added in the playground
// review.  Each is offered by the picker in `web/src/examples/index.ts`
// and exists to demonstrate a slice of the language the older examples
// never touched (inheritance + event sourcing, auth + capabilities, and
// the newest-features multi-file tour).  Like the storybook gate next to
// this file, this is the fast-suite proof that they parse clean and
// generate a system — the slow LOOM_REACT_BUILD / LOOM_DOTNET_BUILD
// matrices don't run on `npm test`, so a grammar/IR drift would otherwise
// land silently and only surface when a contributor picked the example.
//
// `fulfillment-newest.ddd` is multi-file (it imports `shared/kernel.ddd`),
// so it goes through the import-graph project loader rather than a single
// document — exercising the same path `ddd generate system` uses.
const featureExamples = [
  "web/src/examples/inheritance-system.ddd",
  "web/src/examples/auth-capabilities.ddd",
  "web/src/examples/fulfillment-newest.ddd",
  "web/src/examples/persistence-shapes.ddd",
  "web/src/examples/extern-showcase.ddd",
  // The big one: a full six-subdomain ERP across six imported files.
  "web/src/examples/erp/main.ddd",
];

/** Load an example through the multi-file project loader (single-file
 *  sources resolve to a one-document project) and return every document
 *  in the import graph plus the enriched, merged IR. */
async function loadExample(file: string) {
  const services = createDddServices(NodeFileSystem);
  const { all } = await loadProject(URI.file(path.join(repoRoot, file)), services.shared);
  // `lowerProject` composes the whole import graph as one project (the
  // same path the CLI/playground use), so top-level `subdomain`s fold into
  // the lone system — see docs/old/proposals/implicit-system-composition.md.
  const loom = enrichLoomModel(lowerProject(all.map((doc) => doc.parseResult.value as Model)));
  return { all, loom };
}

describe("playground feature examples", () => {
  it.each(featureExamples)("%s parses without errors", async (file) => {
    const { all } = await loadExample(file);
    const errors = all.flatMap((doc) =>
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => `${doc.uri.fsPath}:${d.range.start.line + 1}: ${d.message}`),
    );
    expect(errors).toEqual([]);
  });

  it.each(featureExamples)("%s generates a system", async (file) => {
    const { loom } = await loadExample(file);
    const { files } = generateSystemsFromLoom(loom);
    // Every example declares a `system`, so a docker-compose lands at the
    // output root regardless of how many deployables it wires.
    expect(files.has("docker-compose.yml")).toBe(true);
    expect(files.size).toBeGreaterThan(0);
  });
});
