// byte-equivalence acceptance gate.
//
// The page-IR-walking emitter (`src/generator/react/pages-emitter.ts`)
// must produce output that is byte-for-byte identical to the legacy
// per-aggregate / per-workflow direct walk in the bulk-
// scaffold case.  This test runs the FULL system generator against
// `examples/acme.ddd` and diffs every emitted file against the
// committed baseline at `test/fixtures/baseline-output/`.
//
// What this protects:
// - Wiring `emitPagesForUi` doesn't accidentally drop / reorder /
//   reshape any page output relative to the legacy direct-walk.
// - Override-by-name resolution doesn't trigger when the user
//   writes only a `scaffold modules: <every module>` block.
// - The shared Home / WorkflowsIndex / ViewsIndex pages emit at
//   the same paths with the same content.
//
// When this test fails: either the page-emitter dispatch broke an
// invariant, or the underlying builder changed (legitimate — re-run
// `node scripts/capture-baseline-fixture.mjs` to refresh the
// fixture, review the diff, and commit it).

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const fixtureRoot = path.join(repoRoot, "test/fixtures/baseline-output");

async function buildAcme(): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.file(path.join(repoRoot, "examples/acme.ddd")));
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return doc.parseResult.value as Model;
}

function listFixtureFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFixtureFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

describe("byte-equivalence — page emitter vs legacy direct walk", () => {
  it("emits the same file set as the baseline fixture (paths only)", async () => {
    const model = await buildAcme();
    const { files } = generateSystems(model);
    const emitted = new Set([...files.keys()]);
    const expected = new Set(listFixtureFiles(fixtureRoot));
    // Diff symmetric — fail when either set has paths the other lacks.
    const onlyEmitted = [...emitted].filter((p) => !expected.has(p));
    const onlyExpected = [...expected].filter((p) => !emitted.has(p));
    expect(onlyEmitted, "files emitted but missing from fixture").toEqual([]);
    expect(onlyExpected, "files in fixture but no longer emitted").toEqual([]);
  });

  it("emits byte-identical content for every fixture file", async () => {
    const model = await buildAcme();
    const { files } = generateSystems(model);
    const expected = listFixtureFiles(fixtureRoot);
    const mismatches: string[] = [];
    for (const rel of expected) {
      const baseline = fs.readFileSync(path.join(fixtureRoot, rel), "utf8");
      const live = files.get(rel);
      if (live === undefined) {
        mismatches.push(`MISSING: ${rel}`);
        continue;
      }
      if (live !== baseline) {
        mismatches.push(`DIFFERS: ${rel}`);
      }
    }
    expect(mismatches, "files that drifted from the baseline fixture").toEqual([]);
  });

  it("page objects emit through `emitPageObjectsForUi` when ui is set", async () => {
    // Defence-in-depth: if a refactor accidentally re-routes the
    // page-object emission back through the legacy aggregate /
    // workflow loops, the byte-equivalence test would still
    // pass (same builder, same content, same paths).  This test
    // confirms the path itself by checking that `e2e/pages/*.ts`
    // files are emitted at all (they require both `ui.pages` to
    // contain the right archetype entries AND the per-archetype
    // dispatch in `emitPageObjectsForUi` to route them).
    const model = await buildAcme();
    const { files } = generateSystems(model);
    expect([...files.keys()]).toContain("web_app/e2e/pages/order.ts");
    expect([...files.keys()]).toContain("web_app/e2e/pages/customer.ts");
    expect([...files.keys()]).toContain("web_app/e2e/pages/product.ts");
    expect([...files.keys()]).toContain("web_app/e2e/pages/workflows/place_order.ts");
  });

  it("the new page-IR path is the active one (acme's webApp has uiName populated)", async () => {
    // Defence-in-depth: if a refactor accidentally drops the `ui:`
    // binding from acme.ddd or the lowering, generation would error
    // out without this `uiName`-presence assertion catching the drop
    // first.  Page emission post-#606 has no fallback path — every
    // React project's pages flow through `ui.pages`, so an empty
    // `uiName` would surface as a `loom.react-deployable-missing-ui`
    // validator error rather than silently falling through.
    const { lowerModel } = await import("../../../src/ir/lower/lower.js");
    const { enrichLoomModel } = await import("../../../src/ir/enrich/enrichments.js");
    const model = await buildAcme();
    const loom = enrichLoomModel(lowerModel(model));
    const sys = loom.systems[0]!;
    const webApp = sys.deployables.find((d) => d.name === "webApp")!;
    expect(webApp.uiName).toBe("WebApp");
    const ui = sys.uis.find((u) => u.name === "WebApp");
    expect(ui).toBeDefined();
    // Expander populated `ui.pages` with the scaffold rewrite for
    // Catalog + Sales + CustomerMgmt — at least one Home,
    // WorkflowsIndex plus per-aggregate set.
    const pageNames = ui!.pages.map((p) => p.name);
    expect(pageNames).toContain("Home");
    expect(pageNames).toContain("WorkflowsIndex");
    // Aggregate pages are role-named (`List`), scoped to their per-aggregate
    // area — Catalog/Sales/CustomerMgmt each contribute one `List`.
    expect(pageNames.filter((n) => n === "List").length).toBeGreaterThanOrEqual(3);
  });
});
