import { describe, expect, it } from "vitest";
import { capabilitiesFor } from "../../src/language/ddd-macro-expander.js";
import type { Aggregate, Model } from "../../src/language/generated/ast.js";
import { isAggregate, isOperation, isProperty } from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

// `auditable` references Id<User> and currentUser, so test sources
// always carry a minimal user block so the linker can resolve those.
const wrap = (body: string) =>
  `system Demo { user { id: string  role: string } ${body} }`;

function findAggregate(model: Model, name: string): Aggregate {
  for (const sm of model.members ?? []) {
    if ((sm as any).$type !== "System") continue;
    for (const m of (sm as any).members ?? []) {
      if (m.$type !== "Module") continue;
      for (const ctx of m.contexts ?? []) {
        for (const cm of ctx.members ?? []) {
          if (isAggregate(cm) && cm.name === name) return cm;
        }
      }
    }
  }
  throw new Error(`aggregate ${name} not found`);
}

describe("auditable stdlib macro", () => {
  it("adds 4 audit fields to the aggregate", async () => {
    const { model, errors } = await parseString(
      wrap(`
        module Sales {
          context Orders {
            aggregate Order with auditable {
              subject: string
            }
          }
        }
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const fieldNames = (agg.members ?? []).filter(isProperty).map((p) => p.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining(["subject", "createdAt", "updatedAt", "createdBy", "updatedBy"]),
    );
  });

  it("contributes contextStamps for both create and update events", async () => {
    const { model } = await parseString(
      wrap(`
        module Sales {
          context Orders {
            aggregate Order with auditable {
              subject: string
            }
          }
        }
      `),
    );
    const agg = findAggregate(model, "Order");
    const bag = capabilitiesFor(agg);
    expect(bag.stamps.length).toBe(2);
    expect(bag.stamps.map((s) => s.event).sort()).toEqual(["create", "update"]);
  });

  it("composes with softDeletable — no field collisions", async () => {
    const { model, errors } = await parseString(
      wrap(`
        module Sales {
          context Orders {
            aggregate Order with auditable, softDeletable {
              subject: string
            }
          }
        }
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const fieldNames = (agg.members ?? []).filter(isProperty).map((p) => p.name);
    expect(fieldNames).toEqual(
      expect.arrayContaining([
        "subject",
        "createdAt",
        "updatedAt",
        "createdBy",
        "updatedBy",
        "isDeleted",
        "deletedAt",
      ]),
    );
    const opNames = (agg.members ?? []).filter(isOperation).map((o) => o.name);
    expect(opNames).toEqual(expect.arrayContaining(["softDelete", "restore"]));
    // Both capabilities accumulate on the same host: stamps from
    // auditable + one filter from softDeletable.
    const bag = capabilitiesFor(agg);
    expect(bag.stamps.length).toBe(2);
    expect(bag.filters.length).toBe(1);
  });
});

describe("softDeletable — fixed field names", () => {
  it("uses isDeleted / deletedAt", async () => {
    const { model } = await parseString(
      wrap(`
        module M { context C {
          aggregate Doc with softDeletable {
            subject: string
          }
        }}
      `),
    );
    const agg = findAggregate(model, "Doc");
    const names = (agg.members ?? []).filter(isProperty).map((p) => p.name);
    expect(names).toContain("isDeleted");
    expect(names).toContain("deletedAt");
  });
});

describe("macro expander diagnostics", () => {
  it("reports unknown macro names with available list", async () => {
    const { errors } = await parseString(
      wrap(`
        module M { context C {
          aggregate Order with nonexistent {
            subject: string
          }
        }}
      `),
    );
    expect(errors.join("\n")).toMatch(/Unknown macro 'nonexistent'/);
  });

  it("reports target-kind mismatch", async () => {
    const { errors } = await parseString(
      wrap(`
        ui App with auditable {
          page Home { route: "/" body: List(of: x) }
        }
      `),
    );
    expect(errors.join("\n")).toMatch(
      /Macro 'auditable' targets 'aggregate' but was invoked on a 'ui'/,
    );
  });

  // Arg-validation diagnostics (bad-kind, unknown-arg, etc.) are
  // covered against the scaffold stdlib macro in
  // `test/macro/scaffold-equivalence.test.ts`, which has typed
  // refList/ref params and exercises the same validator code path.
  // The trait macros here intentionally take no args (no surface to
  // mis-fill), so equivalent tests would only assert via a macro
  // that doesn't currently exist in the trait family.
});

describe("override-by-name", () => {
  it("user-declared field with the same name as a macro-added field takes precedence", async () => {
    const { model, errors } = await parseString(
      wrap(`
        module M { context C {
          aggregate Order with auditable {
            createdAt: datetime
            subject: string
          }
        }}
      `),
    );
    expect(errors).toEqual([]);
    const agg = findAggregate(model, "Order");
    const createdAtCount = (agg.members ?? [])
      .filter(isProperty)
      .filter((p) => p.name === "createdAt").length;
    expect(createdAtCount).toBe(1);
  });
});
