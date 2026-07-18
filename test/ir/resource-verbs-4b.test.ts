// Phase 4b — queue/api verbs, the remaining objectStore verbs, and the
// per-verb interface override (signedUrl → rest).

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { findVerb, verbsForKind } from "../../src/ir/resource-verbs.js";
import type { ExprIR, WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

describe("resource-verbs registry (4b)", () => {
  it("ships the full objectStore / queue / api vocabulary", () => {
    expect(verbsForKind("objectStore")).toEqual(["delete", "get", "list", "put", "signedUrl"]);
    expect(verbsForKind("queue")).toEqual(["enqueue", "publish"]);
    expect(verbsForKind("api")).toEqual(["get", "post"]);
  });

  it("marks signedUrl with a rest interface override", () => {
    expect(findVerb("objectStore", "signedUrl")?.interfaceOverride).toBe("rest");
    expect(findVerb("objectStore", "get")?.interfaceOverride).toBeUndefined();
  });
});

function mk(body: string): string {
  return `
system Sys {
  subdomain Sales { context Sales {
    aggregate Order { name: string }
    workflow Archive {
      create(name: string) { ${body} }
    }
  } }
  storage pg { type: postgres }
  storage files { type: s3, config: { bucket: "b" } }
  storage bus { type: rabbitmq }
  storage pay { type: restApi, config: { baseUrl: "https://x" } }
  resource salesState { for: Sales, kind: state, use: pg }
  resource salesFiles { for: Sales, kind: objectStore, use: files }
  resource salesJobs  { for: Sales, kind: queue, use: bus }
  resource salesApi   { for: Sales, kind: api, use: pay }
  deployable api { platform: node, contexts: [Sales], dataSources: [salesState, salesFiles, salesJobs, salesApi], port: 3000 }
}`;
}

async function firstCall(body: string): Promise<Extract<ExprIR, { kind: "call" }>> {
  const { model } = await parseString(mk(body), { validate: false });
  const ctx = lowerModel(model).systems[0]!.subdomains[0]!.contexts[0]!;
  const st = ctx.workflows[0]!.statements.find(
    (s: WorkflowStmtIR) => s.kind === "resource-call" || s.kind === "expr-let",
  );
  const e = st?.kind === "resource-call" ? st.call : st?.kind === "expr-let" ? st.expr : undefined;
  if (e?.kind !== "call") throw new Error("no resource-op call");
  return e;
}

describe("4b verb lowering", () => {
  it("lowers a queue enqueue", async () => {
    const c = await firstCall(`salesJobs.enqueue(name)`);
    expect(c.resourceOp).toMatchObject({
      resourceKind: "queue",
      verb: "enqueue",
      capability: "enqueue",
    });
  });

  it("lowers an api get with the request capability", async () => {
    const c = await firstCall(`let r = salesApi.get("/rate")`);
    expect(c.resourceOp).toMatchObject({ resourceKind: "api", verb: "get", capability: "request" });
  });

  it("threads the rest interface override onto signedUrl", async () => {
    const c = await firstCall(`let u = salesFiles.signedUrl("k")`);
    expect(c.resourceOp).toMatchObject({ verb: "signedUrl", interface: "rest" });
  });
});
