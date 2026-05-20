import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createDddServices } from "../src/language/ddd-module.js";
import { lowerModel } from "../src/ir/lower.js";
import { enrichLoomModel } from "../src/ir/enrichments.js";
import {
  buildDomainDiagram,
  buildWorkflowDiagram,
  renderDomainDiagram,
  renderWorkflowDiagram,
} from "../src/system/mermaid.js";
import type { Model } from "../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// `<outdir>/.loom/domain.mmd` + `.loom/workflows.mmd` snapshots.  Lock
// the Mermaid views so generator changes that alter the structural /
// workflow-flow projections show up as a diffable snapshot review.
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

describe("domain.mmd", () => {
  it("emits the expected classDiagram for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    expect(buildDomainDiagram(loom.systems[0]!)).toMatchSnapshot();
  });

  it("is a deterministic classDiagram with a trailing newline", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const rendered = renderDomainDiagram(sys);
    expect(rendered).toContain("classDiagram");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).toBe(renderDomainDiagram(sys));
  });

  it("renders a class per aggregate with its operations", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const out = buildDomainDiagram(sys);
    for (const m of sys.modules) {
      for (const c of m.contexts) {
        for (const a of c.aggregates) {
          expect(out).toContain(`class ${a.name} {`);
          for (const op of a.operations) {
            expect(out).toContain(`${op.name}(`);
          }
        }
      }
    }
  });
});

describe("workflows.mmd", () => {
  it("emits the expected flowchart for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    expect(buildWorkflowDiagram(loom.systems[0]!)).toMatchSnapshot();
  });

  it("is a deterministic flowchart with a trailing newline", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const rendered = renderWorkflowDiagram(sys);
    expect(rendered).toContain("flowchart TD");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).toBe(renderWorkflowDiagram(sys));
  });
});
