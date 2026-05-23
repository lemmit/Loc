// Hand-written capability declarations produce identical IR to
// macro-emitted ones.  This is the "macros are sugar" proof: every
// macro contribution can be replaced by direct source.  If this
// equivalence ever breaks, the macro system has stopped being sugar
// and has become a privileged channel — exactly what we're trying
// to prevent.

import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../src/ir/loom-ir.js";
import { buildLoomModel } from "../_helpers/ir.js";

function findAgg(
  ir: { systems: { modules: { contexts: { aggregates: AggregateIR[] }[] }[] }[] },
  name: string,
): AggregateIR {
  for (const s of ir.systems) {
    for (const m of s.modules) {
      for (const c of m.contexts) {
        for (const a of c.aggregates) if (a.name === name) return a;
      }
    }
  }
  throw new Error(`aggregate ${name} not found in IR`);
}

describe("source-level capabilities (hand-written, no macro)", () => {
  it("`filter !this.isDeleted` produces contextFilters[0]", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
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
        module M { context C {
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

  it("`implements \"X\"` populates implementsCapabilities", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Doc {
            subject: string
            implements "softDeletable"
            implements "auditable"
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Doc");
    // Sorted + deduped.
    expect(agg.implementsCapabilities).toEqual(["auditable", "softDeletable"]);
  });

  it("hand-written equivalent of `with softDeletable` produces matching IR", async () => {
    // softDeletable expands to: 2 fields, 2 operations, 1 filter,
    // 1 implements.  Writing the same thing by hand should yield
    // an aggregate whose IR matches the macro-produced one
    // structurally for the capability surface.
    const handIR = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Hand {
            subject: string
            isDeleted: bool
            deletedAt: datetime?
            implements "softDeletable"
            filter !this.isDeleted
          }
        }}
      }
    `);
    const macroIR = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Macro with softDeletable {
            subject: string
          }
        }}
      }
    `);
    const hand = findAgg(handIR, "Hand");
    const macro = findAgg(macroIR, "Macro");
    expect(hand.contextFilters?.length).toBe(macro.contextFilters?.length);
    expect(hand.implementsCapabilities).toEqual(macro.implementsCapabilities);
  });
});

describe("context-level propagation", () => {
  it("`filter` at context level applies to every aggregate inside", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M {
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

  it("`implements` at context level propagates the capability name", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M {
          context C {
            implements "softDeletable"
            aggregate Order {
              subject: string
              isDeleted: bool
            }
          }
        }
      }
    `);
    const order = findAgg(ir, "Order");
    expect(order.implementsCapabilities).toEqual(["softDeletable"]);
  });

  it("context-level + aggregate-level capabilities concatenate", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M {
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

  it("context-level `implements` dedupes when aggregate also declares the same", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M {
          context C {
            implements "auditable"
            aggregate Order {
              subject: string
              implements "auditable"
            }
          }
        }
      }
    `);
    const order = findAgg(ir, "Order");
    expect(order.implementsCapabilities).toEqual(["auditable"]);
  });
});
