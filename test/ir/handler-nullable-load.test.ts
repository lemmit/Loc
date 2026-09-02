// `loom.handler-load-nullable-unsupported` (#2659) — the third of the three
// handler-body defects #2652 measured and left unfixed.
//
// A `commandHandler` / `queryHandler` body binding an OPTIONAL repository read
// (`let o = Orders.byCode(c)` over `find byCode(c: string): Order?`) used to
// pass every gate and then emit an UNGUARDED dereference:
//
//   node   const o = await orders.byCode(c);  return o.status;   // TS18047
//   .NET   var o = await _orders.ByCode(...); return o.Status;   // CS8602
//
// A WORKFLOW body refuses exactly that load — `loom.workflow-load-nullable-
// unsupported`, "v1 supports only single non-nullable aggregates" — because
// the statement vocabulary both bodies render through has no null-handling arm.
// The handler body renders through the SAME vocabulary (`WorkflowStmtIR` via
// `renderWorkflowStmtChunks`), so it carries the same limit; it just never said
// so.  This gate mirrors the refusal rather than inventing a 404-on-absent
// semantics the author did not ask for.
//
// (`if let` is NOT the escape hatch here: over a NAMED declared find it is
// broken in a workflow body too — `.RunAsync((null, 1))` against an
// `IUnknownRepository` — a separate, pre-existing defect this gate does not
// touch and does not make worse.)
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

/** `find` return type + the handler kind that consumes it. */
function system(opts: { findRet: string; kind?: string; body?: string }): string {
  const kind = opts.kind ?? "queryHandler";
  const body = opts.body ?? "let o = Orders.byCode(c)\n        return o.status";
  return `
system S {
  subdomain D {
    context Sales {
      aggregate Order { code: string  status: string }
      repository Orders for Order {
        find byCode(c: string): ${opts.findRet} where code == c
      }
      ${kind} CodeStatus(c: string): string {
        ${body}
      }
    }
  }
  api A from D {
    route GET "/orders/by-code/{c}/status" -> Sales.CodeStatus
  }
  storage pg { type: postgres }
  resource s { for: Sales, kind: state, use: pg }
  deployable d { platform: node  contexts: [Sales]  dataSources: [s]  serves: A  port: 3000 }
}
`;
}

async function irDiagnostics(source: string) {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)));
}

const codes = async (source: string) => (await irDiagnostics(source)).map((d) => d.code);

describe("an optional find bound in a handler body is refused, not silently mis-emitted", () => {
  it("refuses the queryHandler leg with the coded diagnostic", async () => {
    const diags = await irDiagnostics(system({ findRet: "Order?" }));
    const hit = diags.find((d) => d.code === "loom.handler-load-nullable-unsupported");
    expect(hit, `got: ${diags.map((d) => d.code).join(", ") || "(none)"}`).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.source).toBe("Sales/CodeStatus");
    // The message names the call and the alternative, not just the rule.
    expect(hit!.message).toContain("queryHandler 'CodeStatus'");
    expect(hit!.message).toContain("'Orders.byCode(...)'");
    expect(hit!.message).toContain("getById");
  });

  it("refuses the commandHandler leg the same way", async () => {
    const hit = (await irDiagnostics(system({ findRet: "Order?", kind: "commandHandler" }))).find(
      (d) => d.code === "loom.handler-load-nullable-unsupported",
    );
    expect(hit?.message).toContain("commandHandler 'CodeStatus'");
  });

  it("CONTROL — the non-optional find (the supported spelling) is clean", async () => {
    expect(await codes(system({ findRet: "Order" }))).not.toContain(
      "loom.handler-load-nullable-unsupported",
    );
  });

  it("CONTROL — `getById` is load-or-throw and stays legal", async () => {
    const src = system({
      findRet: "Order",
      body: "let o = Orders.getById(orderId)\n        return o.status",
    }).replace("CodeStatus(c: string)", "CodeStatus(orderId: Order id)");
    expect(await codes(src)).not.toContain("loom.handler-load-nullable-unsupported");
  });

  it("CONTROL — the workflow twin still owns the workflow body", async () => {
    const src = `
system S {
  subdomain D {
    context Sales {
      aggregate Order { code: string  status: string
        operation cancel() { status := "x" } }
      repository Orders for Order {
        find byCode(c: string): Order? where code == c
      }
      command Cmd { c: string }
      workflow W {
        create(x: Cmd) {
          let o = Orders.byCode(x.c)
          o.cancel()
        }
      }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource s { for: Sales, kind: state, use: pg }
  deployable d { platform: node  contexts: [Sales]  dataSources: [s]  serves: A  port: 3000 }
}
`;
    const got = await codes(src);
    expect(got).toContain("loom.workflow-load-nullable-unsupported");
    expect(got).not.toContain("loom.handler-load-nullable-unsupported");
  });
});

// ---------------------------------------------------------------------------
// The THIRD body kind (domainservice-nullable-load-ungated).  The gate above
// walked `ctx.commandHandlers`/`ctx.queryHandlers` and its workflow twin walked
// workflow bodies; nothing walked `ctx.domainServices[].operations[].body`, so
// the identical load parsed `0 error(s), 0 warning(s)` and emitted an unguarded
// deref on ALL FIVE backends.
// ---------------------------------------------------------------------------
const svcSystem = (findRet: string, body: string) => `
system S {
  subdomain D {
    context Sales {
      aggregate Order { code: string  status: string }
      repository Orders for Order {
        find byCode(c: string): ${findRet} where code == c
      }
      domainService Lookup {
        operation statusOf(c: string): string {
          ${body}
        }
      }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource s { for: Sales, kind: state, use: pg }
  deployable d { platform: node  contexts: [Sales]  dataSources: [s]  serves: A  port: 3000 }
}
`;

describe("an optional find bound in a DOMAIN SERVICE body is refused too", () => {
  const CODE = "loom.handler-load-nullable-unsupported";

  it("refuses the optional load with the coded diagnostic", async () => {
    const diags = await irDiagnostics(
      svcSystem("Order?", "let o = Orders.byCode(c)\n          return o.status"),
    );
    const hit = diags.find((d) => d.code === CODE);
    expect(hit, `got: ${diags.map((d) => d.code).join(", ") || "(none)"}`).toBeDefined();
    expect(hit!.severity).toBe("error");
    expect(hit!.source).toBe("Sales/Lookup.statusOf");
    expect(hit!.message).toContain("domainService 'Lookup.statusOf'");
    expect(hit!.message).toContain("Orders.byCode(...)");
  });

  it("CONTROL — the non-optional find is clean", async () => {
    expect(
      await codes(svcSystem("Order", "let o = Orders.byCode(c)\n          return o.status")),
    ).not.toContain(CODE);
  });

  it("CONTROL — an inline (unbound) optional read is not this gate's business", async () => {
    // `Accounts.byHolder(h) == null` is the shape the corpus fixture ships:
    // nothing is dereferenced, so nothing is unguarded.
    expect(
      await codes(svcSystem("Order?", 'return Orders.byCode(c) == null ? "none" : "some"')),
    ).not.toContain(CODE);
  });

  it("reports ONCE per repo.method however many times the body loads it", async () => {
    const hits = (
      await irDiagnostics(
        svcSystem(
          "Order?",
          "let o = Orders.byCode(c)\n          let p = Orders.byCode(c)\n          return o.status + p.status",
        ),
      )
    ).filter((d) => d.code === CODE);
    expect(hits).toHaveLength(1);
  });
});
