// Object-literal field keys admit reserved soft-keywords.
//
// `ObjectFieldInit` keyed on bare `ID` rejected reserved names like
// `id` / `kind` / `contains` — so `{ id: x }` (the natural shape for a
// queue/objectStore json payload, e.g. `jobs.enqueue({ id: order.id })`)
// failed to parse, while `{ foo: x }` worked.  The key now uses
// `LooseName` (mirroring `EmitField` / `ThemeProp`), admitting the soft
// keywords.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { parseRawResult, parseString } from "../../_helpers/parse.js";

const wf = (body: string) => `
system Sys { subdomain Sales { context Sales {
  aggregate Order { name: string }
  workflow W {
      create(name: string) { ${body} }
    }
} }
storage bus { type: rabbitmq }
resource jobs { for: Sales, kind: queue, use: bus }
deployable api { platform: hono, contexts: [Sales], dataSources: [jobs], port: 3000 }
}`;

describe("object literal — reserved-keyword field keys", () => {
  it("parses an object literal whose key is the reserved `id`", () => {
    const raw = parseRawResult(wf(`let m = { id: name }`));
    expect((raw.parserErrors ?? []).length).toBe(0);
  });

  it("parses multiple reserved soft-keyword keys", () => {
    const raw = parseRawResult(wf(`let m = { id: name, kind: name, contains: name }`));
    expect((raw.parserErrors ?? []).length).toBe(0);
  });

  it("lowers a resource-op called with an `{ id: … }` literal payload", async () => {
    const { model } = await parseString(wf(`jobs.enqueue({ id: name })`), { validate: false });
    const ctx = lowerModel(model).systems[0]!.subdomains[0]!.contexts[0]!;
    const st = ctx.workflows[0]!.statements.find((s) => s.kind === "resource-call");
    expect(st).toBeDefined();
    const call = (st as Extract<typeof st, { kind: "resource-call" }>).call;
    expect(call.kind).toBe("call");
    if (call.kind === "call") {
      expect(call.resourceOp?.verb).toBe("enqueue");
      expect(call.args[0]?.kind).toBe("object");
    }
  });

  it("preserves the key name through lowering", async () => {
    const { model } = await parseString(wf(`let m = { id: name }`), { validate: false });
    const ctx = lowerModel(model).systems[0]!.subdomains[0]!.contexts[0]!;
    const letStmt = ctx.workflows[0]!.statements.find((s) => s.kind === "expr-let");
    const expr = (letStmt as Extract<typeof letStmt, { kind: "expr-let" }>).expr;
    expect(expr.kind).toBe("object");
    if (expr.kind === "object") expect(expr.fields[0]?.name).toBe("id");
  });
});
