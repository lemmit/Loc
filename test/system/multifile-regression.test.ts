import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel, mergeLoomModels } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { loadProject } from "../../src/language/project-loader.js";
import { generateSystems, generateSystemsFromLoom } from "../../src/system/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** Load `entry` as a single document and run the legacy single-file
 *  generator path: parse → lower → enrich → generateSystems. */
async function generateSingleFile(absoluteSourcePath: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
    URI.file(absoluteSourcePath),
  );
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error(
      `parse errors in ${absoluteSourcePath}:\n${errors.map((e) => `  ${e.message}`).join("\n")}`,
    );
  }
  return generateSystems(doc.parseResult.value as Model).files;
}

/** Drive the project-loader path: parse the entry, walk imports,
 *  lower each document, merge, enrich, generate. */
async function generateProject(absoluteEntryPath: string): Promise<Map<string, string>> {
  const services = createDddServices(NodeFileSystem);
  const { all } = await loadProject(URI.file(absoluteEntryPath), services.shared);
  const errors = all.flatMap((d) => (d.diagnostics ?? []).filter((x) => x.severity === 1));
  if (errors.length > 0) {
    throw new Error(`parse errors in project:\n${errors.map((e) => `  ${e.message}`).join("\n")}`);
  }
  const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult.value as Model)));
  const loom = enrichLoomModel(merged);
  return generateSystemsFromLoom(loom).files;
}

function expectEqualFileMaps(a: Map<string, string>, b: Map<string, string>): void {
  const aKeys = [...a.keys()].sort();
  const bKeys = [...b.keys()].sort();
  expect(bKeys, "file set differs").toEqual(aKeys);
  for (const k of aKeys) {
    expect(b.get(k), `content of ${k} differs`).toBe(a.get(k));
  }
}

describe("multi-file regression — byte-identical with the single-file baseline", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mf-regress-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The gating regression: an existing single-file example wrapped
  // in a trivial `main.ddd` that just imports the original file must
  // produce a byte-identical file map.  Proves the multi-file path
  // doesn't perturb generator output.
  for (const example of ["examples/acme.ddd", "examples/provenance.ddd"]) {
    it(`${example}: trivial import wrapper matches single-file output`, async () => {
      const sourceAbs = path.join(repoRoot, example);
      const baseline = await generateSingleFile(sourceAbs);
      expect(baseline.size).toBeGreaterThan(0);

      // Copy the original into the temp dir under a different name,
      // and create a main.ddd that does nothing but import it.
      const innerName = path.basename(example);
      fs.copyFileSync(sourceAbs, path.join(tmp, innerName));
      fs.writeFileSync(path.join(tmp, "main.ddd"), `import "./${innerName}"\n`, "utf8");

      const wrapped = await generateProject(path.join(tmp, "main.ddd"));
      expectEqualFileMaps(baseline, wrapped);
    });
  }

  // End-to-end exercise of the root-level VO emission path: a tiny
  // project with the VO at root in a separate file generates output
  // where the VO actually appears in the per-context emitted code.
  // This confirms the enrichment injection reaches backend emitters.
  it("root-level valueobject in its own file emits into the consuming context", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./shared/money.ddd"
        import "./catalog.ddd"
        system Tiny {
          subdomain M {
            context Catalog {
              aggregate Product {
                sku: string
                price: Money
              }
              repository Products for Product { }
            }
          }
          deployable api { platform: hono, contexts: [Catalog] }
        }
      `,
      "shared/money.ddd": `
        valueobject Money {
          amount: decimal
          currency: string
        }
      `,
      // catalog.ddd is unused (the context is inlined in the system
      // for simplicity).  Imported just to confirm imports of files
      // with no live contributions don't break.
      "catalog.ddd": `// reserved for future catalog content`,
    });

    const files = await generateProject(path.join(tmp, "main.ddd"));
    // The hono backend bundles every VO into a single
    // `domain/value-objects.ts` per deployable.  Confirm the root VO
    // (Money) made it there, *and* that the Product emission imports
    // and references it — proves the injection reaches generators
    // and that the type reference resolves through the linker.
    const vos = files.get("api/domain/value-objects.ts") ?? "";
    expect(vos, "expected value-objects.ts to contain Money").toContain("Money");
    const productRoutes = files.get("api/http/product.routes.ts") ?? "";
    expect(productRoutes, "expected product routes to import Money").toContain(
      'import { Money } from "../domain/value-objects"',
    );
  });

  function writeProject(rootDir: string, files: Record<string, string>): void {
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(rootDir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
  }
});
