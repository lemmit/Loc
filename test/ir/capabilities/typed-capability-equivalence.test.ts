// Typed capabilities — Phase 2 (expander splice + equivalence).
//
// A `capability { fields + filter + stamp }` applied via `with` produces
// byte-identical IR to hand-writing the same fields / filter / stamp on the
// aggregate.  This is the "capability is the declared successor to the
// field/filter/stamp macros" proof: the expander deep-clones the capability's
// members into each implementing aggregate, and lowering reads them
// structurally — no privileged channel.

import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../../src/ir/types/loom-ir.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

function findAgg(
  ir: { systems: { subdomains: { contexts: { aggregates: AggregateIR[] }[] }[] }[] },
  name: string,
): AggregateIR {
  for (const s of ir.systems)
    for (const m of s.subdomains)
      for (const c of m.contexts) for (const a of c.aggregates) if (a.name === name) return a;
  throw new Error(`aggregate ${name} not found in IR`);
}

/** Deep-clone `value` with every `origin` key stripped.  A capability's
 *  spliced members carry no `$cstNode` of their own (the expander doesn't
 *  preserve one on the clone), so `lowerExpr`'s M14 origin wrapper
 *  (src/ir/lower/lower-expr.ts) leaves them `origin: undefined` — while the
 *  hand-written equivalent, lowered straight from real `.ddd` text, gets a
 *  real `source` origin.  The equivalence these tests assert is structural
 *  (same shape once the capability is spliced), not "same origin" — so
 *  strip it before comparing. */
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

describe("typed capability expansion (typed-capabilities.md Phase 2)", () => {
  it("a filter capability via `with` == hand-written filter + field", async () => {
    const viaCapability = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M { context C {
        aggregate Order with trashable { subject: string }
      }}}
    `);
    const handWritten = await buildLoomModel(`
      system Demo { subdomain M { context C {
        aggregate Order {
          subject: string
          isDeleted: bool
          filter !this.isDeleted
        }
      }}}
    `);
    const a = findAgg(viaCapability, "Order");
    const b = findAgg(handWritten, "Order");
    expect(JSON.stringify(stripOrigin(a.contextFilters))).toEqual(
      JSON.stringify(stripOrigin(b.contextFilters)),
    );
    expect(a.wireShape.map((f) => f.name)).toEqual(b.wireShape.map((f) => f.name));
  });

  it("a fields + stamp capability via `with` == hand-written", async () => {
    const viaCapability = await buildLoomModel(`
      capability tracked {
        createdAt: datetime
        updatedAt: datetime
        stamp onCreate { createdAt := now() }
        stamp onUpdate { updatedAt := now() }
      }
      system Demo { subdomain M { context C {
        aggregate Order with tracked { subject: string }
      }}}
    `);
    const handWritten = await buildLoomModel(`
      system Demo { subdomain M { context C {
        aggregate Order {
          subject: string
          createdAt: datetime
          updatedAt: datetime
          stamp onCreate { createdAt := now() }
          stamp onUpdate { updatedAt := now() }
        }
      }}}
    `);
    const a = findAgg(viaCapability, "Order");
    const b = findAgg(handWritten, "Order");
    expect(JSON.stringify(stripOrigin(a.contextStamps))).toEqual(
      JSON.stringify(stripOrigin(b.contextStamps)),
    );
    expect(a.wireShape.map((f) => f.name)).toEqual(b.wireShape.map((f) => f.name));
  });

  it("one capability is reused across many aggregates (independent clones)", async () => {
    const ir = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M { context C {
        aggregate Order with trashable { subject: string }
        aggregate Invoice with trashable { total: int }
      }}}
    `);
    for (const name of ["Order", "Invoice"]) {
      const agg = findAgg(ir, name);
      expect(agg.contextFilters?.length).toBe(1);
      expect(agg.wireShape.some((f) => f.name === "isDeleted")).toBe(true);
    }
  });

  it("the capability declaration itself contributes no aggregate / validation error", async () => {
    const { errors } = await parseString(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M { context C {
        aggregate Order with trashable { subject: string }
      }}}
    `);
    expect(errors).toEqual([]);
  });

  it("context-level `with` applies the capability to every aggregate (the *ByDefault replacement)", async () => {
    const ir = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M {
        context C with trashable {
          aggregate Order { subject: string }
          aggregate Invoice { total: int }
        }
      }}
    `);
    for (const name of ["Order", "Invoice"]) {
      const agg = findAgg(ir, name);
      expect(agg.contextFilters?.length).toBe(1);
      expect(agg.wireShape.some((f) => f.name === "isDeleted")).toBe(true);
    }
  });

  it("context-level `with` == applying the capability to each aggregate individually", async () => {
    const viaContext = await buildLoomModel(`
      capability tracked {
        createdAt: datetime
        stamp onCreate { createdAt := now() }
      }
      system Demo { subdomain M {
        context C with tracked {
          aggregate Order { subject: string }
        }
      }}
    `);
    const viaAggregate = await buildLoomModel(`
      capability tracked {
        createdAt: datetime
        stamp onCreate { createdAt := now() }
      }
      system Demo { subdomain M {
        context C {
          aggregate Order with tracked { subject: string }
        }
      }}
    `);
    const a = findAgg(viaContext, "Order");
    const b = findAgg(viaAggregate, "Order");
    expect(JSON.stringify(a.contextStamps)).toEqual(JSON.stringify(b.contextStamps));
    expect(a.wireShape.map((f) => f.name)).toEqual(b.wireShape.map((f) => f.name));
  });

  it("an aggregate's own member wins over a context-applied capability member (override-by-name)", async () => {
    const ir = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M {
        context C with trashable {
          aggregate Order { subject: string  isDeleted: bool }
        }
      }}
    `);
    const agg = findAgg(ir, "Order");
    // The aggregate's explicit isDeleted suppresses the capability's clone — so
    // exactly one isDeleted field, no duplicate column.
    expect(agg.wireShape.filter((f) => f.name === "isDeleted").length).toBe(1);
  });

  it("an unknown `with` name that is neither macro nor capability errors", async () => {
    const { errors } = await parseString(`
      system Demo { subdomain M { context C {
        aggregate Order with nope { subject: string }
      }}}
    `);
    expect(errors.join("\n")).toMatch(/Unknown macro or capability 'nope'/);
  });

  // --- Phase 4b: typed `implements <Cap>` (synonym of `with <Cap>`) ----------

  it("typed `implements <Cap>` == `with <Cap>`", async () => {
    const viaImplements = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M { context C {
        aggregate Order { implements trashable  subject: string }
      }}}
    `);
    const viaWith = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M { context C {
        aggregate Order with trashable { subject: string }
      }}}
    `);
    const a = findAgg(viaImplements, "Order");
    const b = findAgg(viaWith, "Order");
    expect(JSON.stringify(a.contextFilters)).toEqual(JSON.stringify(b.contextFilters));
    expect(a.wireShape.map((f) => f.name)).toEqual(b.wireShape.map((f) => f.name));
  });

  it("typed `implements <Cap>` at context scope applies to every aggregate", async () => {
    const ir = await buildLoomModel(`
      capability trashable {
        isDeleted: bool
        filter !this.isDeleted
      }
      system Demo { subdomain M {
        context C {
          implements trashable
          aggregate Order { subject: string }
          aggregate Invoice { total: int }
        }
      }}
    `);
    for (const name of ["Order", "Invoice"]) {
      const agg = findAgg(ir, name);
      expect(agg.contextFilters?.length).toBe(1);
      expect(agg.wireShape.some((f) => f.name === "isDeleted")).toBe(true);
    }
  });

  it("typed `implements` naming no capability errors", async () => {
    const { errors } = await parseString(`
      system Demo { subdomain M { context C {
        aggregate Order { implements nope  subject: string }
      }}}
    `);
    expect(errors.join("\n")).toMatch(/Unknown capability 'nope' in 'implements'/);
  });
});
