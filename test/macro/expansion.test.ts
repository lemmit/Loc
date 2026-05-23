import { describe, expect, it } from "vitest";
import { flagsFor } from "../../src/language/ddd-macro-expander.js";
import type { Aggregate, Model } from "../../src/language/generated/ast.js";
import { isAggregate, isOperation, isProperty } from "../../src/language/generated/ast.js";
import { parseString } from "../_helpers/parse.js";

const wrap = (body: string) => `system Demo { ${body} }`;

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

  it("sets the isAuditable capability flag", async () => {
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
    const bag = flagsFor(agg);
    expect(bag.flags.has("isAuditable")).toBe(true);
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
    const bag = flagsFor(agg);
    expect(bag.flags.has("isAuditable")).toBe(true);
    expect(bag.flags.has("softDelete")).toBe(true);
  });
});

describe("softDeletable arg defaults", () => {
  it("uses default field names without args", async () => {
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

  it("honors custom field names via args", async () => {
    const { model } = await parseString(
      wrap(`
        module M { context C {
          aggregate Doc with softDeletable(field: "archived", timestamp: "archivedOn") {
            subject: string
          }
        }}
      `),
    );
    const agg = findAggregate(model, "Doc");
    const names = (agg.members ?? []).filter(isProperty).map((p) => p.name);
    expect(names).toContain("archived");
    expect(names).toContain("archivedOn");
    expect(names).not.toContain("isDeleted");
    const bag = flagsFor(agg);
    expect(bag.flags.get("softDelete")).toEqual({
      field: "archived",
      timestamp: "archivedOn",
    });
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

  it("reports bad arg type", async () => {
    const { errors } = await parseString(
      wrap(`
        module M { context C {
          aggregate Doc with softDeletable(field: 42) {
            subject: string
          }
        }}
      `),
    );
    expect(errors.join("\n")).toMatch(/expected kind 'string'/);
  });

  it("reports unknown arg name", async () => {
    const { errors } = await parseString(
      wrap(`
        module M { context C {
          aggregate Doc with softDeletable(bogus: "x") {
            subject: string
          }
        }}
      `),
    );
    expect(errors.join("\n")).toMatch(/Unknown argument 'bogus'/);
  });
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
