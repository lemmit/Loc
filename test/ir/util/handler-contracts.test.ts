import { describe, expect, it } from "vitest";
import type { BoundedContextIR, TypeIR } from "../../../src/ir/types/loom-ir.js";
import {
  normalizeHandlerReturn,
  requestRecordFor,
} from "../../../src/ir/util/handler-contracts.js";

// Every backend's explicit-handler emitter reads these two to interpret a
// scaffolded handler's signature.  They decide whether a param deserialises
// from a request DTO and whether the handler's INTERNAL signature types on the
// domain entity or its wire record — so a disagreement between backends is a
// handler that compiles on one and not another.  M-T9.17 slice 2 — no direct
// test.
//
// The subtlety both functions turn on: payloads are `entity`-marked TypeIRs
// (lowering marks them so), so `kind === "entity"` does NOT mean "aggregate".
// Telling a record from a real aggregate requires consulting `ctx.payloads`,
// and every branch below exists because that lookup can miss.

const entity = (name: string): TypeIR => ({ kind: "entity", name }) as TypeIR;
const array = (element: TypeIR): TypeIR => ({ kind: "array", element }) as TypeIR;

/** A context with one aggregate (`Order`, owning part `Line`) and the payload
 *  set a scaffolded handler surface produces. */
const ctx = (): BoundedContextIR =>
  ({
    name: "Orders",
    aggregates: [{ name: "Order", parts: [{ name: "Line" }] }],
    payloads: [
      { name: "CreateOrderCommand", kind: "command" },
      { name: "GetOrderQuery", kind: "query" },
      { name: "OrderResponse", kind: "response" },
      { name: "LineResponse", kind: "response" },
      { name: "OrderPlacedEvent", kind: "event" },
    ],
  }) as unknown as BoundedContextIR;

describe("requestRecordFor", () => {
  it("resolves a COMMAND record param", () => {
    expect(requestRecordFor(entity("CreateOrderCommand"), ctx())?.name).toBe("CreateOrderCommand");
  });

  it("resolves a QUERY record param", () => {
    expect(requestRecordFor(entity("GetOrderQuery"), ctx())?.name).toBe("GetOrderQuery");
  });

  it("is undefined for a payload that is neither command nor query", () => {
    // A response or event payload is entity-marked too — the kind filter is
    // what stops a handler treating one as its request body.
    expect(requestRecordFor(entity("OrderResponse"), ctx())).toBeUndefined();
    expect(requestRecordFor(entity("OrderPlacedEvent"), ctx())).toBeUndefined();
  });

  it("is undefined for a real aggregate — an id/entity param, not a record", () => {
    expect(requestRecordFor(entity("Order"), ctx())).toBeUndefined();
  });

  it("is undefined for a non-entity type", () => {
    expect(requestRecordFor({ kind: "string" } as TypeIR, ctx())).toBeUndefined();
    // An ARRAY of a command record is not itself a record param: the function
    // does not unwrap, so a `Cmd[]` param stays a plain list.
    expect(requestRecordFor(array(entity("CreateOrderCommand")), ctx())).toBeUndefined();
  });
});

describe("normalizeHandlerReturn", () => {
  it("passes an undefined (void) return through", () => {
    expect(normalizeHandlerReturn(undefined, ctx())).toBeUndefined();
  });

  it("passes a scalar return through unchanged", () => {
    const t = { kind: "string" } as TypeIR;
    expect(normalizeHandlerReturn(t, ctx())).toBe(t);
  });

  it("leaves a declared AGGREGATE return alone — the hand-written form", () => {
    const t = entity("Order");
    expect(normalizeHandlerReturn(t, ctx())).toBe(t);
  });

  it("maps `<Agg>Response` back to the aggregate — the scaffolded form", () => {
    expect(normalizeHandlerReturn(entity("OrderResponse"), ctx())).toEqual(entity("Order"));
  });

  it("maps a PART's response back to the part, not just aggregates", () => {
    // `entityForResponseName` checks containment parts too; an emitter that
    // only knew aggregates would leave `LineResponse` untouched and type the
    // handler on a wire record.
    expect(normalizeHandlerReturn(entity("LineResponse"), ctx())).toEqual(entity("Line"));
  });

  it("KEEPS array-ness while mapping the element", () => {
    expect(normalizeHandlerReturn(array(entity("OrderResponse")), ctx())).toEqual(
      array(entity("Order")),
    );
  });

  it("leaves a response record whose stripped name matches nothing", () => {
    // `GhostResponse` is a response payload, but there is no `Ghost` entity —
    // the mapping must not invent one.
    const withGhost = {
      ...ctx(),
      payloads: [...ctx().payloads, { name: "GhostResponse", kind: "response" }],
    } as unknown as BoundedContextIR;
    const t = entity("GhostResponse");
    expect(normalizeHandlerReturn(t, withGhost)).toBe(t);
  });

  it("leaves an entity-marked name that is not a response payload at all", () => {
    const t = entity("CreateOrderCommand");
    expect(normalizeHandlerReturn(t, ctx())).toBe(t);
  });

  it("does not strip a bare `Response` suffix off a real aggregate", () => {
    // An aggregate genuinely NAMED `Response` short-circuits on the
    // aggregate check before the suffix strip — otherwise it would map to the
    // empty string.
    const odd = {
      name: "Orders",
      aggregates: [{ name: "Response", parts: [] }],
      payloads: [],
    } as unknown as BoundedContextIR;
    const t = entity("Response");
    expect(normalizeHandlerReturn(t, odd)).toBe(t);
  });
});
