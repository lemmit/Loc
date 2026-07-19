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

  // Regression (docs/audits/repo-code-review-2026-07.md I1): `deriveNeeds`
  // walked only WORKFLOW bodies (and only two statement shapes).  A resource-op
  // in a command/query HANDLER — a separate context field — derived no need, so
  // `validateNeedCapabilities` never checked the resource offers the verb.  The
  // deep walk now covers handlers too.
  const HANDLER_SRC = `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    commandHandler Stash(name: string) { salesFiles.put("k/" + name, name) }
  } }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "b" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  deployable api { platform: node, contexts: [Sales], dataSources: [salesState, salesFiles], port: 3000 }
}`;

  it("derives a need for a resource-op used in a command handler (not just workflows)", async () => {
    const { model } = await parseString(HANDLER_SRC, { validate: false });
    const sys = enrichLoomModel(lowerModel(model)).systems[0]!;
    const need = sys.needs.find((n) => n.contextName === "Sales" && n.kind === "objectStore");
    expect(need, "handler resource-op must derive an objectStore need").toBeDefined();
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

// ── mailer kind (M-T4.6) ─────────────────────────────────────────────
const MAILER = `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { customerEmail: string }
    workflow Notify { create(customerEmail: string) { __BODY__ } }
  } }
  storage pg { type: postgres }
  storage mailServer { type: smtp, config: { from: "no-reply@acme.test" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource mail { for: Sales, kind: mailer, use: mailServer }
  deployable api { platform: node, contexts: [Sales], dataSources: [salesState, mail], port: 3000 }
}`;

async function mailerDiags(body: string) {
  const { model } = await parseString(MAILER.replace("__BODY__", body), { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

describe("mailer resource-op", () => {
  it("lowers `mail.send(...)` to a resource-op carrying the mailer kind + send capability", async () => {
    const { model } = await parseString(
      MAILER.replace("__BODY__", `mail.send(customerEmail, "s", "b")`),
      { validate: false },
    );
    const ctx = lowerModel(model).systems[0]!.subdomains[0]!.contexts.find(
      (c) => c.name === "Sales",
    )!;
    const call = asCall(
      ctx.workflows
        .find((w) => w.name === "Notify")!
        .statements.find((s) => s.kind === "resource-call"),
    );
    expect(call.callKind).toBe("resource-op");
    expect(call.resourceOp).toMatchObject({
      resourceName: "mail",
      resourceKind: "mailer",
      verb: "send",
      capability: "send",
    });
  });

  it("accepts a valid mail.send workflow", async () => {
    const diags = await mailerDiags(`mail.send(customerEmail, "Order", "Thanks")`);
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("rejects an unknown mailer verb", async () => {
    const diags = await mailerDiags(`mail.blast(customerEmail)`);
    expect(
      diags.some(
        (d) => d.severity === "error" && /is not a valid verb for a mailer/.test(d.message),
      ),
    ).toBe(true);
  });
});
