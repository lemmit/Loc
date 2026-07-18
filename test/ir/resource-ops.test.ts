// Phase 4a — workflow-level resource consumption (objectStore put/get).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR, WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

function mk(workflowBody: string, opts: { transactional?: boolean } = {}): string {
  const t = opts.transactional ? " transactional" : "";
  return `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    workflow Archive${t} { create(name: string) { ${workflowBody} } }
  } }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "b" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  deployable api { platform: node, contexts: [Sales], dataSources: [salesState, salesFiles], port: 3000 }
}`;
}

async function lowerWf(
  workflowBody: string,
  opts?: { transactional?: boolean },
): Promise<WorkflowStmtIR[]> {
  const { model } = await parseString(mk(workflowBody, opts), { validate: false });
  const sys = lowerModel(model).systems[0]!;
  const ctx = sys.subdomains[0]!.contexts.find((c) => c.name === "Sales")!;
  return ctx.workflows.find((w) => w.name === "Archive")!.statements;
}

async function diagnostics(workflowBody: string, opts?: { transactional?: boolean }) {
  const { model } = await parseString(mk(workflowBody, opts), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const asCall = (s: WorkflowStmtIR | undefined): Extract<ExprIR, { kind: "call" }> => {
  const e = s?.kind === "resource-call" ? s.call : s?.kind === "expr-let" ? s.expr : undefined;
  if (e?.kind !== "call") throw new Error(`not a call stmt: ${s?.kind}`);
  return e;
};

describe("resource-op lowering", () => {
  it("lowers a bare `files.put(...)` to a resource-call statement", async () => {
    const stmts = await lowerWf(`salesFiles.put("k/" + name, name)`);
    const call = asCall(stmts.find((s) => s.kind === "resource-call"));
    expect(call.callKind).toBe("resource-op");
    expect(call.resourceOp).toMatchObject({
      resourceName: "salesFiles",
      resourceKind: "objectStore",
      verb: "put",
      capability: "blob",
    });
  });

  it("lowers `let x = files.get(k)` to an expr-let holding a resource-op", async () => {
    const stmts = await lowerWf(`let blob = salesFiles.get("k/" + name)`);
    const call = asCall(stmts.find((s) => s.kind === "expr-let"));
    expect(call.callKind).toBe("resource-op");
    expect(call.resourceOp?.verb).toBe("get");
  });
});

describe("usage-derived needs", () => {
  it("adds an objectStore need carrying the verb's capability", async () => {
    const { model } = await parseString(mk(`salesFiles.put("k", name)`), { validate: false });
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const need = sys.needs.find((n) => n.contextName === "Sales" && n.kind === "objectStore");
    expect(need).toBeDefined();
    expect(need!.capabilities).toContain("blob");
  });
});

describe("resource-op validation", () => {
  it("accepts a valid put/get workflow", async () => {
    const diags = await diagnostics(`salesFiles.put("k", name)`);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("rejects an unknown verb for the kind", async () => {
    const diags = await diagnostics(`salesFiles.frobnicate("k")`);
    expect(
      diags.some(
        (d) => d.severity === "error" && /is not a valid verb for a objectStore/.test(d.message),
      ),
    ).toBe(true);
  });

  it("rejects a resource-op inside a transactional workflow", async () => {
    const diags = await diagnostics(`salesFiles.put("k", name)`, { transactional: true });
    expect(
      diags.some(
        (d) =>
          d.severity === "error" && /cannot run inside a transactional workflow/.test(d.message),
      ),
    ).toBe(true);
  });
});
