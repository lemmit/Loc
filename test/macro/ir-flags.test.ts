// Verifies macro-contributed capability flags propagate through
// lowering onto AggregateIR.flags, where generators consume them.

import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../src/ir/loom-ir.js";
import { buildLoomModel } from "../_helpers/ir.js";

function findAgg(ir: { systems: { modules: { contexts: { aggregates: AggregateIR[] }[] }[] }[] }, name: string): AggregateIR {
  for (const s of ir.systems) {
    for (const m of s.modules) {
      for (const c of m.contexts) {
        for (const a of c.aggregates) if (a.name === name) return a;
      }
    }
  }
  throw new Error(`aggregate ${name} not found in IR`);
}

describe("macro flags propagate to AggregateIR", () => {
  it("auditable sets flags.isAuditable=true", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Order with auditable {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Order");
    expect(agg.flags?.isAuditable).toBe(true);
  });

  it("softDeletable sets flags.softDelete with field/timestamp", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Doc with softDeletable {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Doc");
    expect(agg.flags?.softDelete).toEqual({ field: "isDeleted", timestamp: "deletedAt" });
  });

  it("softDeletable args override the defaults", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Doc with softDeletable(field: "archived", timestamp: "archivedOn") {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Doc");
    expect(agg.flags?.softDelete).toEqual({ field: "archived", timestamp: "archivedOn" });
  });

  it("composed macros yield both flags", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Order with auditable, softDeletable {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Order");
    expect(agg.flags?.isAuditable).toBe(true);
    expect(agg.flags?.softDelete).toEqual({ field: "isDeleted", timestamp: "deletedAt" });
  });

  it("aggregates without macros have undefined flags", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        module M { context C {
          aggregate Plain {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Plain");
    expect(agg.flags).toBeUndefined();
  });
});
