// Hand-written capability declarations produce identical IR to
// macro-emitted ones.  This is the "macros are sugar" proof: every
// macro contribution can be replaced by direct source.  If this
// equivalence ever breaks, the macro system has stopped being sugar
// and has become a privileged channel — exactly what we're trying
// to prevent.

import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/ir.js";

function findAgg(
  ir: { systems: { modules: { contexts: { aggregates: AggregateIR[] }[] }[] }[] },
  name: string,
): AggregateIR {
  for (const s of ir.systems) {
    for (const m of s.subdomains) {
      for (const c of m.contexts) {
        for (const a of c.aggregates) if (a.name === name) return a;
      }
    }
  }
  throw new Error(`aggregate ${name} not found in IR`);
}

/** Deep-clone `value` with every `origin` key stripped.  A prelude/macro
 *  capability's spliced members carry no `$cstNode` of their own, so
 *  `lowerExpr`'s M14 origin wrapper (src/ir/lower/lower-expr.ts) leaves
 *  them `origin: undefined` — while the hand-written equivalent, lowered
 *  straight from real `.ddd` text, gets a real `source` origin.  The
 *  equivalence this test asserts is structural, not "same origin" — see
 *  the matching helper in typed-capability-equivalence.test.ts. */
function stripOrigin<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripOrigin(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "origin") continue;
      out[k] = stripOrigin(v);
    }
    return out as T;
  }
  return value;
}

describe("source-level capabilities (hand-written, no macro)", () => {
  it("`filter !this.isDeleted` produces contextFilters[0]", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          aggregate Doc {
            subject: string
            isDeleted: bool
            filter !this.isDeleted
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Doc");
    expect(agg.contextFilters?.length).toBe(1);
    const pred = agg.contextFilters![0]!;
    expect(pred.kind).toBe("unary");
    if (pred.kind === "unary") {
      expect(pred.op).toBe("!");
      expect(pred.operand.kind).toBe("member");
    }
  });

  it("`stamp onCreate { ... }` produces contextStamps[0]", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          aggregate Doc {
            createdAt: datetime
            subject: string
            stamp onCreate {
              createdAt := now()
            }
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Doc");
    expect(agg.contextStamps?.length).toBe(1);
    const rule = agg.contextStamps![0]!;
    expect(rule.event).toBe("create");
    expect(rule.assignments[0]!.field).toBe("createdAt");
  });

  it("the `softDeletable` capability == hand-written state + filter", async () => {
    // The built-in capability co-locates state + filter on the aggregate;
    // hand-writing the same fields + `filter` yields matching IR.
    const handIR = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          aggregate Order {
            subject: string
            isDeleted: bool internal
            deletedAt: datetime? managed
            filter !this.isDeleted
          }
        }}
      }
    `);
    const capIR = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          aggregate Order with softDeletable {
            subject: string
          }
        }}
      }
    `);
    const hand = findAgg(handIR, "Order");
    const cap = findAgg(capIR, "Order");
    expect(JSON.stringify(stripOrigin(hand.contextFilters))).toEqual(
      JSON.stringify(stripOrigin(cap.contextFilters)),
    );
    expect(hand.wireShape.map((f) => f.name)).toEqual(cap.wireShape.map((f) => f.name));
  });
});

describe("context-level propagation", () => {
  it("`filter` at context level applies to every aggregate inside", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
          context C {
            filter !this.isDeleted
            aggregate Order {
              subject: string
              isDeleted: bool
            }
            aggregate Customer {
              name: string
              isDeleted: bool
            }
          }
        }
      }
    `);
    const order = findAgg(ir, "Order");
    const customer = findAgg(ir, "Customer");
    expect(order.contextFilters?.length).toBe(1);
    expect(customer.contextFilters?.length).toBe(1);
  });

  it("context-level + aggregate-level capabilities concatenate", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
          context C {
            filter !this.isDeleted
            aggregate Order {
              subject: string
              isDeleted: bool
              archived: bool
              filter !this.archived
            }
          }
        }
      }
    `);
    const order = findAgg(ir, "Order");
    // Two filters: one propagated from context, one declared locally.
    expect(order.contextFilters?.length).toBe(2);
  });
});

describe("context-level filter propagation", () => {
  it("an unqualified context filter propagates to every aggregate", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
          context C {
            filter !this.isDeleted
            aggregate Order {
              subject: string
              isDeleted: bool
            }
            aggregate Customer {
              name: string
              isDeleted: bool
            }
          }
        }
      }
    `);
    expect(findAgg(ir, "Order").contextFilters?.length).toBe(1);
    expect(findAgg(ir, "Customer").contextFilters?.length).toBe(1);
  });
});

describe("macro-call composition: `*ByDefault` context macros", () => {
  it("`with softDeleteByDefault` fans state + filter + ops across every aggregate", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M { context C with softDeleteByDefault {
          aggregate Order { subject: string }
          aggregate Customer { name: string }
        }}
      }
    `);
    for (const name of ["Order", "Customer"]) {
      const agg = findAgg(ir, name);
      expect(agg.contextFilters?.length).toBe(1);
      expect(agg.wireShape.map((f) => f.name)).toEqual(
        expect.arrayContaining(["isDeleted", "deletedAt"]),
      );
      expect((agg.operations ?? []).map((o) => o.name)).toEqual(
        expect.arrayContaining(["softDelete", "restore"]),
      );
    }
  });

  it("`softDeleteByDefault` matches explicit `with softDeletable, softDelete` per aggregate", async () => {
    const byDefault = await buildLoomModel(`
      system Demo {
        subdomain M { context C with softDeleteByDefault {
          aggregate Order { subject: string }
        }}
      }
    `);
    const explicit = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          aggregate Order with softDeletable, softDelete { subject: string }
        }}
      }
    `);
    const orderD = findAgg(byDefault, "Order");
    const orderE = findAgg(explicit, "Order");
    expect(JSON.stringify(orderD.contextFilters)).toEqual(JSON.stringify(orderE.contextFilters));
    expect(orderD.wireShape.map((f) => f.name)).toEqual(orderE.wireShape.map((f) => f.name));
    expect((orderD.operations ?? []).map((o) => o.name)).toEqual(
      (orderE.operations ?? []).map((o) => o.name),
    );
  });

  it("context-level `with auditable` fans the capability (fields + stamps) to every aggregate", async () => {
    // Typed-capabilities Phase 3: the built-in `auditable` capability applied at
    // context scope replaces the former `auditedByDefault` macro.
    const ir = await buildLoomModel(`
      system Demo {
        user { id: string  role: string }
        subdomain M { context C with auditable {
          aggregate Order { subject: string }
          aggregate Customer { name: string }
        }}
      }
    `);
    for (const name of ["Order", "Customer"]) {
      const agg = findAgg(ir, name);
      expect(agg.contextStamps?.length).toBe(2);
      expect(agg.wireShape.map((f) => f.name)).toEqual(
        expect.arrayContaining(["createdAt", "updatedAt", "createdBy", "updatedBy"]),
      );
    }
  });
});
