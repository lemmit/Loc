import { describe, expect, it } from "vitest";
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
import { loadExampleModel, toLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// `<outdir>/.loom/domain.mmd` + `.loom/workflows.mmd` snapshots.  Lock
// the Mermaid views so generator changes that alter the structural /
// workflow-flow projections show up as a diffable snapshot review.
// ---------------------------------------------------------------------------

async function build(file: string) {
  return toLoomModel(await loadExampleModel(file));
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
    for (const m of sys.subdomains) {
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
    for (const m of sys.subdomains) {
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
    for (const m of sys.subdomains) expect(out).toContain(`📦 ${m.name}`);
    expect(renderDeploymentDiagram(sys).endsWith("\n")).toBe(true);
  });

  it("defines every context node an edge references (no dangling ctx_* nodes)", async () => {
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const out = buildDeploymentDiagram(sys);
    // Nodes DEFINED: `ctx_X["📁 …"]`.  Nodes REFERENCED by an edge: `--> ctx_X`.
    const defined = new Set([...out.matchAll(/(ctx_[A-Za-z0-9_]+)\[/g)].map((m) => m[1]));
    const referenced = new Set(
      [...out.matchAll(/\|serves\| (ctx_[A-Za-z0-9_]+)/g)].map((m) => m[1]),
    );
    expect(referenced.size).toBeGreaterThan(0);
    for (const ref of referenced) expect(defined).toContain(ref);
    // Ownership is visible: each subdomain-owned context nests under its 📦.
    for (const m of sys.subdomains) {
      for (const ctx of m.contexts) expect(out).toContain(`📁 ${ctx.name}`);
    }
  });

  it("does not draw `serves` edges from a frontend (only its `calls` edge)", async () => {
    // acme's `webApp` is a static SPA that inherits its target's context set
    // for wire-scope — it must NOT claim to serve those contexts.
    const sys = (await build("examples/acme.ddd")).systems[0]!;
    const web = sys.deployables.find((d) => d.name === "webApp")!;
    expect(web.platform).toBe("static");
    const out = buildDeploymentDiagram(sys);
    expect(out).not.toContain("deploy_webApp -->|serves|");
    // …but the honest relationship — calling its backend — is still drawn.
    expect(out).toContain("deploy_webApp -.->|calls| deploy_api");
  });
});
