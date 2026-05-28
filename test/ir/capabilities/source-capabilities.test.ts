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

  it('`implements "X"` populates implementsCapabilities', async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
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

  it("hand-written equivalent of trio (softDelete + softDeletable) produces matching IR", async () => {
    // Trio shape: context-level capability filter + aggregate-level
    // state + opt-in via `implements`.  Writing the equivalent by
    // hand should yield identical IR for the capability surface.
    const handIR = await buildLoomModel(`
      system Demo {
        subdomain M { context C {
          filter for "softDeletable" !this.isDeleted
          aggregate Hand {
            subject: string
            isDeleted: bool
            deletedAt: datetime?
            implements "softDeletable"
          }
        }}
      }
    `);
    const macroIR = await buildLoomModel(`
      system Demo {
        subdomain M { context C with softDelete {
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

  it("`implements` at context level propagates the capability name", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
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

  it("context-level `implements` dedupes when aggregate also declares the same", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
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

describe('capability-scoped context filters: `filter for "<name>"`', () => {
  it("propagates only to aggregates with matching `implements`", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
          context C {
            filter for "softDeletable" !this.isDeleted
            aggregate Order {
              subject: string
              isDeleted: bool
              implements "softDeletable"
            }
            aggregate Public {
              name: string
            }
          }
        }
      }
    `);
    const order = findAgg(ir, "Order");
    const pub = findAgg(ir, "Public");
    expect(order.contextFilters?.length).toBe(1);
    expect(pub.contextFilters).toBeUndefined();
  });

  it("unqualified context filter still propagates to every aggregate", async () => {
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

  it("multiple capability-scoped filters route to the right aggregates", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M {
          context C {
            filter for "softDeletable" !this.isDeleted
            filter for "drafted" !this.isDraft
            aggregate Soft {
              subject: string
              isDeleted: bool
              implements "softDeletable"
            }
            aggregate Draft {
              subject: string
              isDraft: bool
              implements "drafted"
            }
            aggregate Both {
              subject: string
              isDeleted: bool
              isDraft: bool
              implements "softDeletable"
              implements "drafted"
            }
            aggregate Neither {
              subject: string
            }
          }
        }
      }
    `);
    expect(findAgg(ir, "Soft").contextFilters?.length).toBe(1);
    expect(findAgg(ir, "Draft").contextFilters?.length).toBe(1);
    expect(findAgg(ir, "Both").contextFilters?.length).toBe(2);
    expect(findAgg(ir, "Neither").contextFilters).toBeUndefined();
  });
});

describe('capability-scoped context stamps: `stamp for "<name>"`', () => {
  it('`stamp for "auditable" onCreate { ... }` propagates only to opt-ins', async () => {
    const ir = await buildLoomModel(`
      system Demo {
        user { id: string  role: string }
        subdomain M {
          context C {
            stamp for "auditable" onCreate {
              createdAt := now()
            }
            aggregate Order {
              subject: string
              createdAt: datetime
              implements "auditable"
            }
            aggregate Plain {
              subject: string
            }
          }
        }
      }
    `);
    expect(findAgg(ir, "Order").contextStamps?.length).toBe(1);
    expect(findAgg(ir, "Plain").contextStamps).toBeUndefined();
  });
});

describe("macro-call composition: `*ByDefault` context macros", () => {
  it("`with softDeleteByDefault` on a context fans softDeletable across every aggregate", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        subdomain M { context C with softDeleteByDefault {
          aggregate Order { subject: string }
          aggregate Customer { name: string }
        }}
      }
    `);
    // Both aggregates received: implements + filter propagated.
    const order = findAgg(ir, "Order");
    const customer = findAgg(ir, "Customer");
    expect(order.implementsCapabilities).toContain("softDeletable");
    expect(customer.implementsCapabilities).toContain("softDeletable");
    expect(order.contextFilters?.length).toBe(1);
    expect(customer.contextFilters?.length).toBe(1);
  });

  it("`softDeleteByDefault` matches explicit composition of softDelete + softDeletable", async () => {
    const byDefault = await buildLoomModel(`
      system Demo {
        subdomain M { context C with softDeleteByDefault {
          aggregate Order { subject: string }
        }}
      }
    `);
    const explicit = await buildLoomModel(`
      system Demo {
        subdomain M { context C with softDelete {
          aggregate Order with softDeletable { subject: string }
        }}
      }
    `);
    const orderD = findAgg(byDefault, "Order");
    const orderE = findAgg(explicit, "Order");
    expect(orderD.implementsCapabilities).toEqual(orderE.implementsCapabilities);
    expect(orderD.contextFilters?.length).toBe(orderE.contextFilters?.length);
  });

  it("`with auditedByDefault` fans auditable state + audit stamps", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        user { id: string  role: string }
        subdomain M { context C with auditedByDefault {
          aggregate Order { subject: string }
          aggregate Customer { name: string }
        }}
      }
    `);
    for (const name of ["Order", "Customer"]) {
      const agg = findAgg(ir, name);
      expect(agg.implementsCapabilities).toContain("auditable");
      expect(agg.contextStamps?.length).toBe(2);
    }
  });
});
