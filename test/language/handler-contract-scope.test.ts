// Scope arm: transport types (`event` / `command` / `query` / `response` /
// `error`) in an application-layer handler CONTRACT position.
//
// `ddd-scope.ts` keeps transport records out of ordinary type positions on
// purpose — a stray event name in an aggregate field must resolve to nothing
// (a clear "could not resolve") rather than silently typing as a transport
// record.  The admitted positions are transport BOUNDARIES: a workflow
// `create`/`handle` param, a union variant, and — since `inHandlerContract` —
// a `commandHandler`/`queryHandler` record param and its response return:
//
//   queryHandler GetOrder(query: GetOrderQuery): OrderResponse { … }
//
// This file pins BOTH halves of that arm: the two slots that must now link,
// and the neighbouring positions that must still refuse, so a future widening
// cannot quietly become "transport types resolve everywhere".

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import {
  isCommandHandler,
  isQueryHandler,
  type NamedType,
} from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const PRELUDE = `
        aggregate Order {
          status: string
          operation cancel() { status := "cancelled" }
        }
        repository Orders for Order { }
        response OrderResponse { status: string  version: int }
        query GetOrderQuery { orderId: Order id }
        command CancelOrderCommand { reason: string }
`;

/** One context wrapping `PRELUDE` plus whatever members the case adds. */
const ctx = (members: string): string => `
  system Shop {
    subdomain Sales {
      context Ordering {
${PRELUDE}
${members}
      }
    }
  }
`;

const HANDLERS = `
        queryHandler GetOrder(query: GetOrderQuery): OrderResponse {
          let o = Orders.getById(query.orderId)
          return o
        }
        commandHandler CancelOrder(cmd: CancelOrderCommand): OrderResponse {
          let o = Orders.getById(cmd.reason)
          o.cancel()
          return o
        }
`;

/** Every `NamedType` in the model, by the name it references. */
async function namedTypes(src: string): Promise<Map<string, NamedType[]>> {
  const { model } = await parseString(src, { validate: false });
  const out = new Map<string, NamedType[]>();
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type !== "NamedType") continue;
    const nt = node as NamedType;
    const name = nt.target?.$refText;
    if (!name) continue;
    out.set(name, [...(out.get(name) ?? []), nt]);
  }
  return out;
}

describe("handler contract scope — the admitted positions link", () => {
  it("resolves a `query` record param and a `response` return on a queryHandler", async () => {
    const types = await namedTypes(ctx(HANDLERS));
    for (const name of ["GetOrderQuery", "OrderResponse"]) {
      const refs = types.get(name) ?? [];
      expect(refs.length, `no NamedType references ${name}`).toBeGreaterThan(0);
      for (const nt of refs) {
        expect(nt.target.ref, `${name} did not link`).toBeDefined();
        expect(nt.target.ref?.$type).toBe("PayloadDecl");
      }
    }
  });

  it("resolves a `command` record param on a commandHandler", async () => {
    const types = await namedTypes(ctx(HANDLERS));
    const refs = types.get("CancelOrderCommand") ?? [];
    expect(refs.length).toBeGreaterThan(0);
    for (const nt of refs) expect(nt.target.ref?.$type).toBe("PayloadDecl");
  });

  it("parses + AST-validates the hand-written record-param handler form clean", async () => {
    const { errors } = await parseString(ctx(HANDLERS));
    expect(errors).toEqual([]);
  });

  it("reaches both handler kinds' param AND return slots (the fixture is not half-empty)", async () => {
    const { model } = await parseString(ctx(HANDLERS), { validate: false });
    const nodes = [...AstUtils.streamAllContents(model)];
    const q = nodes.filter(isQueryHandler);
    const c = nodes.filter(isCommandHandler);
    expect(q).toHaveLength(1);
    expect(c).toHaveLength(1);
    for (const h of [...q, ...c]) {
      expect(h.params).toHaveLength(1);
      expect(h.returnType).toBeDefined();
    }
  });
});

describe("handler contract scope — the neighbouring positions still refuse", () => {
  // Each case names a transport record from a position that is NOT a transport
  // boundary.  The widening must not reach any of them, so the reference stays
  // unresolvable and the user gets "could not resolve" instead of a field/param
  // silently typed as a transport record.
  const cases: Array<[string, string, string]> = [
    ["an aggregate field", "OrderResponse", `aggregate Bad { stray: OrderResponse }`],
    [
      "an operation param",
      "GetOrderQuery",
      `aggregate Bad2 { note: string  operation touch(q: GetOrderQuery) { note := "x" } }`,
    ],
    [
      "a repository find param",
      "GetOrderQuery",
      `repository Bad3 for Order { find byQ(q: GetOrderQuery): Order[] where this.status == "x" }`,
    ],
    [
      "a value-object field",
      "CancelOrderCommand",
      `valueobject Bad4 { stray: CancelOrderCommand }`,
    ],
  ];

  for (const [where, name, member] of cases) {
    it(`does not resolve a transport record in ${where}`, async () => {
      const { errors } = await parseString(ctx(`${HANDLERS}\n${member}`));
      // Named, so the assertion cannot be satisfied by SOME OTHER unresolved
      // reference the fixture happens to carry.
      const unresolved = `Could not resolve reference to NamedDecl named '${name}'.`;
      expect(
        errors.some((e) => e.endsWith(unresolved)),
        `expected "${unresolved}" from ${where}, got: ${JSON.stringify(errors)}`,
      ).toBe(true);
      // …and the handlers in the same context still link (the refusal is
      // positional, not "this whole fixture is broken").
      const types = await namedTypes(ctx(`${HANDLERS}\n${member}`));
      const handlerRefs = (types.get("OrderResponse") ?? []).filter(
        (nt) => nt.$container?.$container?.$type?.endsWith("Handler") === true,
      );
      expect(handlerRefs.length).toBeGreaterThan(0);
      for (const nt of handlerRefs) expect(nt.target.ref?.$type).toBe("PayloadDecl");
    });
  }

  it("still refuses in those positions when the handlers are absent too", async () => {
    const { errors } = await parseString(ctx(`aggregate Bad { stray: OrderResponse }`));
    expect(
      errors.some((e) =>
        e.endsWith("Could not resolve reference to NamedDecl named 'OrderResponse'."),
      ),
    ).toBe(true);
  });
});
