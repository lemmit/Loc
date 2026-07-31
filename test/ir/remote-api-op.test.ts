// M-T4.8 slice 2 — the TYPED call surface over an in-system api binding.
//
// `orders.getOrderById(id)` resolves against the CALLEE's derived operation set
// (slice 0's `ApiOperationIR`) instead of the closed per-kind verb registry, and
// carries the callee's response type — so the next statement's `o.code` type-
// checks.  That is the whole difference from the untyped `get(path): json`
// escape hatch, and it is why the operation set has to be available DURING
// lowering rather than in enrichment.
//
// The structural pre-pass (`preLowerBoundApiOperations`) is what buys that: the
// target contexts are lowered once, structurally, purely to derive their
// operations.  These tests pin both halves — that the pre-pass runs only for
// BOUND apis, and that the resulting call is fully resolved.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR, WorkflowStmtIR } from "../../src/ir/types/loom-ir.js";
import { walkWorkflowStmtExprsDeep } from "../../src/ir/util/walk.js";
import { REMOTE_API_OP_UNSUPPORTED } from "../../src/ir/validate/checks/system-checks.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

function system(body: string, opts: { bindApi?: boolean; callerPlatform?: string } = {}): string {
  const bindApi = opts.bindApi ?? true;
  const callerPlatform = opts.callerPlatform ?? "node";
  return `
system Acme {
  subdomain Core {
    context Orders {
      aggregate Order with crudish { code: string  status: string }
      repository Orders for Order { }
    }
    context Shipping {
      aggregate Shipment with crudish { orderCode: string  status: string }
      repository Shipments for Shipment { }
      workflow fulfil {
${body}
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  storage ordersHttp { type: restApi, config: { baseUrl: "http://elsewhere:3000" } }
  resource ordersState   { for: Orders,   kind: state, use: primary }
  resource shippingState { for: Shipping, kind: state, use: primary }
  resource orders        { for: Shipping, kind: api,   use: ${bindApi ? "OrdersApi" : "ordersHttp"} }
  deployable ordersSvc {
    platform: node contexts: [Orders] dataSources: [ordersState] serves: OrdersApi port: 3000
  }
  deployable shippingSvc {
    platform: ${callerPlatform} contexts: [Shipping] dataSources: [shippingState, orders] port: 3001
  }
}
`;
}

const TYPED_CALL = `        create(id: Order id) {
          let o = orders.getOrderById(id)
          let s = Shipment.create({ orderCode: o.code, status: "Pending" })
        }`;

async function lower(source: string) {
  const { model } = await parseString(source, { validate: false });
  return enrichLoomModel(lowerModel(model));
}

/** Every expression in the `fulfil` workflow's body. */
async function workflowExprs(source: string): Promise<ExprIR[]> {
  const loom = await lower(source);
  const ctx = loom.systems[0]?.subdomains[0]?.contexts.find((c) => c.name === "Shipping");
  const wf = ctx?.workflows[0];
  if (!wf) throw new Error("no workflow lowered");
  const out: ExprIR[] = [];
  for (const st of wf.statements as WorkflowStmtIR[]) {
    walkWorkflowStmtExprsDeep(st, (e) => out.push(e));
  }
  return out;
}

function remoteCalls(exprs: readonly ExprIR[]) {
  return exprs.filter(
    (e): e is Extract<ExprIR, { kind: "call" }> =>
      e.kind === "call" && e.callKind === "remote-api-op",
  );
}

describe("typed in-system api call — lowering", () => {
  it("resolves the operation against the callee's derived surface", async () => {
    const calls = remoteCalls(await workflowExprs(system(TYPED_CALL)));
    expect(calls).toHaveLength(1);

    const op = calls[0]?.remoteApiOp;
    expect(op?.resourceName).toBe("orders");
    expect(op?.apiName).toBe("OrdersApi");
    expect(op?.operationId).toBe("getOrderById");
    expect(op?.method).toBe("get");
    // ABSOLUTE wire path — the caller must not have to know how the callee
    // mounts its sub-routers.  This is the exact bug the untyped path allowed:
    // a hand-written "/orders/{id}" compiled clean and 404'd at runtime.
    expect(op?.path).toBe("/api/orders/{id}");
    // `type` rides along too: a backend whose ids are not strings (.NET) has
    // to coerce the argument at the call site, and must decide that from the
    // same source the client's parameter type is derived from.
    expect(op?.params).toEqual([
      { name: "id", location: "path", type: { kind: "primitive", name: "guid" } },
    ]);
  });

  it("types the result as the callee's response, so a field read resolves", async () => {
    const exprs = await workflowExprs(system(TYPED_CALL));
    // `o.code` — the read that only type-checks because the call carried a
    // real type.  Under the untyped `get(path): json` path this is `json`.
    const member = exprs.find((e) => e.kind === "member" && e.member === "code");
    expect(member).toBeDefined();
    if (member?.kind !== "member") throw new Error("expected a member expr");
    expect(member.receiverType).toEqual({ kind: "entity", name: "Order" });
    expect(member.memberType).toEqual({ kind: "primitive", name: "string" });
  });

  it("types a failure union from the callee's non-2xx statuses", async () => {
    const calls = remoteCalls(await workflowExprs(system(TYPED_CALL)));
    // A getById can answer 404 — the client must be able to type that rather
    // than collapsing every non-2xx into a throw.
    expect(calls[0]?.remoteApiOp?.errorStatuses).toContain(404);
  });

  it("leaves an unknown operation unresolved rather than inventing one", async () => {
    const body = `        create(id: Order id) {
          let o = orders.noSuchOperation(id)
        }`;
    const exprs = await workflowExprs(system(body));
    expect(remoteCalls(exprs)).toHaveLength(0);
  });
});

describe("typed in-system api call — the pre-pass gate", () => {
  it("does not treat a storage-bound api resource as typed", async () => {
    // Same `.getOrderById(...)` spelling, but the resource binds a `storage
    // restApi` — an API Loom does not own.  It must stay on the untyped verb
    // path, not silently acquire the sibling service's operation set.
    const exprs = await workflowExprs(system(TYPED_CALL, { bindApi: false }));
    expect(remoteCalls(exprs)).toHaveLength(0);
  });
});

describe("typed in-system api call — backend support gate", () => {
  // DERIVED, not hardcoded.  This assertion has already broken twice by naming
  // a platform that a later slice made supported (node in slice 3, python in
  // 4a) — the test was pinning a temporary state instead of a behaviour.  It
  // now picks whatever is still on the list, and disappears on its own when the
  // list empties and the gate is deleted.
  const stillUnsupported = [...REMOTE_API_OP_UNSUPPORTED][0];

  it.skipIf(!stillUnsupported)(
    "rejects the call on a backend with no typed client yet",
    async () => {
      const diags = validateLoomModel(
        await lower(system(TYPED_CALL, { callerPlatform: stillUnsupported as string })),
      );
      const d = diags.find((x) => x.code === "loom.remote-api-op-unsupported");
      expect(d?.severity).toBe("error");
      expect(d?.message).toContain("getOrderById");
      expect(d?.message).toContain("shippingSvc");
    },
  );

  it("accepts the call on a backend whose typed client ships", async () => {
    const diags = validateLoomModel(await lower(system(TYPED_CALL)));
    expect(diags.filter((d) => d.code === "loom.remote-api-op-unsupported")).toEqual([]);
  });

  it("stays silent for a system with no api-bound resource", async () => {
    const diags = validateLoomModel(await lower(system(TYPED_CALL, { bindApi: false })));
    expect(diags.filter((d) => d.code === "loom.remote-api-op-unsupported")).toEqual([]);
  });
});
