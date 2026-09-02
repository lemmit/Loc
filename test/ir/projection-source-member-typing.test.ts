// Member typing inside a query-time projection whose SOURCE is another
// projection (`from <Projection> as t`).
//
// A projection ROW is a state-bearing record like a workflow: a `this` /
// source-alias reference types as `{ kind: "entity", name: <Proj> }`, and a
// member off it must resolve against the SOURCE projection's declared row
// fields.  The entity-branch lookup chain in `memberType` / `stepInto` ran
// entities → events → payloads → workflows and then gave up, so every
// projection-row member typed as `string`:
//
//   • `select total = t.total + 1` — a string-typed left operand makes `+` an
//     implicit string CONCAT, and `wrapInStringConvert` wraps the numeric right
//     operand.  Every backend then emits nonsense with ZERO diagnostics:
//     `r.Total + 1.ToString(CultureInfo.InvariantCulture)` (.NET, won't
//     compile), `x.total() + String.valueOf(1)` (Java, won't compile),
//     `record.total <> to_string(1)` (Phoenix), `r.total + String(1)` (Hono,
//     against a `z.number().int()` wire schema), `r.total + str(1)` (FastAPI).
//   • `select total = sum(t.total)` — the aggregation's result type comes from
//     the aggregated column, so the row field typed `string` instead of `int`.
//   • `where t.total > 100` — comparison operands typed `string`.
//
// The identical expressions over an AGGREGATE source are the control: they have
// always typed correctly.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type ExprIR, type ProjectionIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `
system S {
  subdomain D { context C {
    aggregate Order { total: int  status: string }
    repository Orders for Order { }
    event OrderPlaced { order: Order id  total: int }
    projection OrderTotals keyed by orderId {
      orderId: Order id
      total: int
      on(e: OrderPlaced) by e.order { orderId := e.order  total := e.total }
    }
    ${body}
  }}
  storage primary { type: postgres }
  resource cState { for: C, kind: state, use: primary }
  deployable api { platform: node  contexts: [C]  dataSources: [cState] }
}`;

async function lowerProjection(name: string, body: string): Promise<ProjectionIR> {
  const { model } = await parseString(wrap(body), { validate: false });
  const ctx = allContexts(lowerModel(model)).find((c) => c.name === "C")!;
  return ctx.projections.find((p) => p.name === name)!;
}

/** True when the tree contains a string-`convert` wrapper anywhere — the
 *  fingerprint of arithmetic that silently lowered as string concatenation. */
function hasStringConvert(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const node = e as Record<string, unknown>;
  if (node.kind === "convert" && node.target === "string") return true;
  return Object.values(node).some((v) =>
    Array.isArray(v) ? v.some(hasStringConvert) : hasStringConvert(v),
  );
}

const PROJECTION_SOURCE = `
  projection BigOrders {
    orderId: Order id
    total: int
    from OrderTotals as t where t.total > 100
    select orderId = t.orderId, total = t.total + 1
  }`;

const AGGREGATE_SOURCE = `
  projection BigOrdersAgg {
    orderId: Order id
    total: int
    from Order as o where o.total > 100
    select orderId = o.id, total = o.total + 1
  }`;

describe("query-time projection over a projection source — member typing", () => {
  it("types a source-alias member read from the SOURCE projection's row field (not string)", async () => {
    const p = await lowerProjection("BigOrders", PROJECTION_SOURCE);
    const total = p.query!.selects!.find((s) => s.field === "total")!;
    const sum = total.expr as ExprIR & { left: ExprIR };
    expect(sum.left).toMatchObject({
      kind: "member",
      member: "total",
      receiver: { kind: "this" },
      receiverType: { kind: "entity", name: "OrderTotals" },
      memberType: { kind: "primitive", name: "int" },
    });
  });

  it("lowers `t.total + 1` as numeric arithmetic — no string-convert wrapper", async () => {
    const p = await lowerProjection("BigOrders", PROJECTION_SOURCE);
    const total = p.query!.selects!.find((s) => s.field === "total")!;
    expect(hasStringConvert(total.expr)).toBe(false);
    expect(total.expr).toMatchObject({
      op: "+",
      leftType: { kind: "primitive", name: "int" },
      rightType: { kind: "primitive", name: "int" },
      resultType: { kind: "primitive", name: "int" },
    });
    expect(total.type).toEqual({ kind: "primitive", name: "int" });
    // A row field that is an `X id` keeps its id type through the same path.
    const orderId = p.query!.selects!.find((s) => s.field === "orderId")!;
    expect(orderId.type).toMatchObject({ kind: "id", targetName: "Order" });
  });

  it("types the `where` comparison operands from the row shape too", async () => {
    const p = await lowerProjection("BigOrders", PROJECTION_SOURCE);
    expect(p.query!.filter).toMatchObject({
      op: ">",
      leftType: { kind: "primitive", name: "int" },
      rightType: { kind: "primitive", name: "int" },
    });
  });

  it("types a whole-table aggregation from the aggregated row column", async () => {
    const p = await lowerProjection(
      "Summed",
      `projection Summed { total: int  from OrderTotals as t select total = sum(t.total) }`,
    );
    const total = p.query!.selects!.find((s) => s.field === "total")!;
    expect(total.aggregate?.op).toBe("sum");
    expect(total.type).toEqual({ kind: "primitive", name: "int" });
  });

  it("control: the identical expressions over an AGGREGATE source are unchanged", async () => {
    const p = await lowerProjection("BigOrdersAgg", AGGREGATE_SOURCE);
    const total = p.query!.selects!.find((s) => s.field === "total")!;
    expect(hasStringConvert(total.expr)).toBe(false);
    const sum = total.expr as ExprIR & { left: ExprIR };
    expect(sum.left).toMatchObject({
      receiverType: { kind: "entity", name: "Order" },
      memberType: { kind: "primitive", name: "int" },
    });
  });
});
