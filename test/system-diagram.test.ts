import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { lowerModel } from "../src/ir/lower.js";
import { enrichLoomModel } from "../src/ir/enrichments.js";
import { buildSystemDiagram, renderSystemDiagram } from "../src/system/mermaid.js";
import type { Model } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// `<outdir>/.loom/system.mmd` snapshot.  Locks the Mermaid system
// diagram so generator changes that alter the structural view show up
// as a diffable snapshot review.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

async function build(file: string) {
  const services = createDddServices(NodeFileSystem);
  const doc =
    await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
      URI.file(path.join(repoRoot, file)),
    );
  await services.shared.workspace.DocumentBuilder.build([doc], {
    validation: true,
  });
  return enrichLoomModel(lowerModel(doc.parseResult.value as Model));
}

describe("system.mmd", () => {
  it("emits the expected Mermaid for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    expect(buildSystemDiagram(sys)).toMatchSnapshot();
  });

  it("is a deterministic flowchart with a trailing newline", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    const rendered = renderSystemDiagram(sys);
    expect(rendered.startsWith("%% Loom system diagram")).toBe(true);
    expect(rendered).toContain("flowchart TD");
    expect(rendered.endsWith("\n")).toBe(true);
    // Stable across runs.
    expect(rendered).toBe(renderSystemDiagram(sys));
  });

  it("renders a subgraph per module and a node per deployable", async () => {
    const loom = await build("examples/acme.ddd");
    const sys = loom.systems[0]!;
    const out = buildSystemDiagram(sys);
    for (const m of sys.modules) {
      expect(out).toContain(`📦 ${m.name}`);
    }
    for (const d of sys.deployables) {
      expect(out).toContain(`${d.name} · ${d.platform}`);
    }
  });
});
