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

// The rest of the example picker (`web/src/examples/index.ts`) — every
// entry NOT already gated by `playground-feature-examples.test.ts`
// (inheritance / auth / fulfillment / persistence / extern / erp) or
// `playground-storybook-examples.test.ts` (the eight storybooks).
//
// Together the three files gate the WHOLE picker: parse clean + generate
// a system without throwing.  The gap this closes is real — the
// storefront / *-system / showcase sources had no fast-suite gate at all,
// which is how the Elixir examples' descriptions drifted to the removed
// Ash foundation unnoticed.  A grammar/IR change that breaks one of these
// now fails `npm test` instead of only surfacing when a contributor picks
// the example (or in the slow LOOM_REACT_BUILD / LOOM_DOTNET_BUILD matrices).
//
// Uses the multi-file project loader, so the two multi-file entries
// (`multifile-main`, `multifile-landing`) resolve their imported
// companions the same way `ddd generate system` does.
const examples = [
  "web/src/examples/multifile-main.ddd",
  "web/src/examples/multifile-landing.ddd",
  "web/src/examples/loom-landing.ddd",
  "web/src/examples/storybook-components.ddd",
  "web/src/examples/action-showcase.ddd",
  "web/src/examples/store-showcase.ddd",
  "web/src/examples/subform-showcase.ddd",
  "web/src/examples/svelte-store-showcase.ddd",
  "web/src/examples/storefront-system.ddd",
  "web/src/examples/storefront-dotnet.ddd",
  "web/src/examples/storefront-elixir.ddd",
  "web/src/examples/pokemon-world.ddd",
  "web/src/examples/sales-system.ddd",
  "web/src/examples/banking-system.ddd",
  "web/src/examples/inventory-system.ddd",
  "web/src/examples/provenance-system.ddd",
  "web/src/examples/acme.ddd",
  "web/src/examples/dotnet-backend.ddd",
];

async function loadExample(file: string) {
  const services = createDddServices(NodeFileSystem);
  const { all } = await loadProject(URI.file(path.join(repoRoot, file)), services.shared);
  const loom = enrichLoomModel(lowerProject(all.map((doc) => doc.parseResult.value as Model)));
  return { all, loom };
}

describe("playground picker examples (remaining)", () => {
  it.each(examples)("%s parses without errors", async (file) => {
    const { all } = await loadExample(file);
    const errors = all.flatMap((doc) =>
      (doc.diagnostics ?? [])
        .filter((d) => d.severity === 1)
        .map((d) => `${doc.uri.fsPath}:${d.range.start.line + 1}: ${d.message}`),
    );
    expect(errors).toEqual([]);
  });

  it.each(examples)("%s generates a system", async (file) => {
    const { loom } = await loadExample(file);
    const { files } = generateSystemsFromLoom(loom);
    expect(files.has("docker-compose.yml")).toBe(true);
    expect(files.size).toBeGreaterThan(0);
  });
});
