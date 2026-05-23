// Verifies macro-contributed capabilities propagate through lowering
// onto AggregateIR.contextFilters / contextStamps.  Replaces the
// previous `ir-flags.test.ts` which asserted against the old
// `flags.isAuditable` / `flags.softDelete` shape.

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

describe("macro capabilities propagate to AggregateIR", () => {
  it("auditable populates contextStamps with onCreate + onUpdate rules", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        user { id: string  role: string }
        module M { context C {
          aggregate Order with auditable {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Order");
    expect(agg.contextStamps).toBeDefined();
    const events = (agg.contextStamps ?? []).map((s) => s.event).sort();
    expect(events).toEqual(["create", "update"]);
    // Create rule stamps createdAt + createdBy.
    const createRule = agg.contextStamps!.find((s) => s.event === "create")!;
    const createFields = createRule.assignments.map((a) => a.field).sort();
    expect(createFields).toEqual(["createdAt", "createdBy"]);
    // Update rule stamps updatedAt + updatedBy.
    const updateRule = agg.contextStamps!.find((s) => s.event === "update")!;
    const updateFields = updateRule.assignments.map((a) => a.field).sort();
    expect(updateFields).toEqual(["updatedAt", "updatedBy"]);
  });

  it("softDeletable populates contextFilters with one predicate", async () => {
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
    expect(agg.contextFilters).toBeDefined();
    expect(agg.contextFilters!.length).toBe(1);
    // The predicate is `!this.isDeleted`: a unary `!` over a member
    // access whose receiver lowers to `{ kind: "this" }`.
    const pred = agg.contextFilters![0]!;
    expect(pred.kind).toBe("unary");
    if (pred.kind === "unary") {
      expect(pred.op).toBe("!");
      expect(pred.operand.kind).toBe("member");
      if (pred.operand.kind === "member") {
        expect(pred.operand.member).toBe("isDeleted");
        expect(pred.operand.receiver.kind).toBe("this");
      }
    }
  });

  it("composed macros yield both capability kinds, independently", async () => {
    const ir = await buildLoomModel(`
      system Demo {
        user { id: string  role: string }
        module M { context C {
          aggregate Order with auditable, softDeletable {
            subject: string
          }
        }}
      }
    `);
    const agg = findAgg(ir, "Order");
    expect(agg.contextStamps?.length).toBe(2);
    expect(agg.contextFilters?.length).toBe(1);
  });

  it("aggregates without macros have undefined capabilities", async () => {
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
    expect(agg.contextFilters).toBeUndefined();
    expect(agg.contextStamps).toBeUndefined();
  });
});
