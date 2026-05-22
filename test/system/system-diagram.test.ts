import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrichments.js";
import { lowerModel } from "../../src/ir/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import {
  buildDeploymentDiagram,
  buildDomainDiagram,
  buildErDiagram,
  buildSequenceDiagram,
  buildWorkflowDiagram,
  renderDeploymentDiagram,
  renderDomainDiagram,
  renderErDiagram,
  renderSequenceDiagram,
  renderWorkflowDiagram,
} from "../../src/system/mermaid.js";

// ---------------------------------------------------------------------------
// `<outdir>/.loom/domain.mmd` + `.loom/workflows.mmd` snapshots.  Lock
// the Mermaid views so generator changes that alter the structural /
// workflow-flow projections show up as a diffable snapshot review.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

async function build(file: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(
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

describe("er.mmd", () => {
  it("emits the expected erDiagram for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    expect(buildErDiagram(loom.systems[0]!)).toMatchSnapshot();
  });

  it("declares an entity per aggregate with an id PK", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const out = buildErDiagram(sys);
    expect(out).toContain("erDiagram");
    for (const m of sys.modules) {
      for (const c of m.contexts) {
        for (const a of c.aggregates) {
          expect(out).toContain(`  ${a.name} {`);
        }
      }
    }
    expect(out).toContain("id PK");
    expect(renderErDiagram(sys).endsWith("\n")).toBe(true);
  });
});

describe("sequence.mmd", () => {
  it("emits the expected sequenceDiagram for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    expect(buildSequenceDiagram(loom.systems[0]!)).toMatchSnapshot();
  });

  it("is a deterministic sequenceDiagram with a trailing newline", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const rendered = renderSequenceDiagram(sys);
    expect(rendered).toContain("sequenceDiagram");
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered).toBe(renderSequenceDiagram(sys));
  });
});

describe("deployment.mmd", () => {
  it("emits the expected flowchart for examples/acme.ddd", async () => {
    const loom = await build("examples/acme.ddd");
    expect(buildDeploymentDiagram(loom.systems[0]!)).toMatchSnapshot();
  });

  it("renders a node per deployable and module", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const out = buildDeploymentDiagram(sys);
    expect(out).toContain("flowchart LR");
    for (const d of sys.deployables) expect(out).toContain(`${d.name} · ${d.platform}`);
    for (const m of sys.modules) expect(out).toContain(`📦 ${m.name}`);
    expect(renderDeploymentDiagram(sys).endsWith("\n")).toBe(true);
  });
});
