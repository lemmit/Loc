// A capability `filter` on an aggregate that participates in a TPH hierarchy.
//
// Three defects lived here, all one root cause — a subtype's inherited identity
// stopped at its FIELD LIST — and each shipped SILENTLY (no compile error, no
// diagnostic, and the emitted SQL returns the rows the filter exists to hide):
//
//   F2-CB-C4  a criterion reading a BASE-declared field emitted no predicate at
//             all.  The base's fields are merged onto the subtype by the ENRICH
//             pass (phase ⑥), which runs AFTER expression lowering (⑤b) — so
//             `this.retired` on the subtype typed as the `string` fallback, the
//             Drizzle boolean-column path rejected it, and `contextFilterPredicate`
//             returned `null`, dropping the WHOLE conjunction.
//   F2-CB-C3  the predicate was lowered against `schema.<subtypePlural>` — a
//             table object that does not exist under TPH (7 × TS2339), while the
//             read it is AND-ed into selects from the shared base table.
//   F2-CB-C12 the polymorphic base reader read the shared table directly, so it
//             applied none of the filters both concrete repositories apply.
//
// The corpus never paired inheritance with a filter (tph.ddd / inheritance.ddd
// carry neither `filter` nor `tenantOwned`), which is why no compile gate ever
// reached any of them.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// These fixtures used to ride the legacy `generateHono` helper on a BARE loose
// context.  Once that path asserts phase ⑦ (M-T9.48) the shape is refused, and
// correctly: TPH is a HOSTED capability — `validateInheritanceStorage` reports
// `loom.tph-backend-unsupported` ("no TPH-capable backend deployable hosts this
// context") — and the legacy path cannot host anything, because declaring a
// `system` re-parents every loose context into it and empties the
// `loom.contexts` list `generateTypeScript` emits from.  So the fixture grows
// the deployable it always implied and emits through the orchestrator instead.
// The map is re-keyed to drop the deployable directory, so every assertion
// below reads the same path it did before.
async function gen(contextSrc: string): Promise<Map<string, string>> {
  const files = await generateSystemFiles(`
    system Fleets {
      subdomain D {
        ${contextSrc}
      }
      storage primary { type: postgres }
      resource fleetState { for: Fleet, kind: state, use: primary }
      deployable api {
        platform: node
        contexts: [Fleet]
        dataSources: [fleetState]
        port: 3000
      }
    }
  `);
  return new Map([...files].map(([k, v]) => [k.replace(/^api\//, ""), v]));
}

/** `abstract Vehicle { name, retired }` + `Car extends Vehicle` carrying a
 *  capability filter.  `criterionOn` picks whose field the criterion reads. */
const hierarchy = (criterionBody: string): string => `
  context Fleet {
    criterion Live of Car = ${criterionBody}
    abstract aggregate Vehicle {
      name: string
      retired: bool
    }
    aggregate Car extends Vehicle {
      doors: int
      filter Live
    }
    aggregate Truck extends Vehicle {
      payloadKg: int
    }
    repository Cars for Car { }
    repository Trucks for Truck { }
  }
`;

describe("TPH × capability filter (Hono/Drizzle)", () => {
  it("a criterion reading a BASE-declared field still emits its predicate", async () => {
    const files = await gen(hierarchy("!this.retired"));
    const repo = files.get("db/repositories/car-repository.ts") ?? "";
    expect(repo, "concrete repository emitted").not.toEqual("");
    // The criterion reifies to a module-level fn, and `retired` must be typed
    // `bool` for the boolean-column path to accept it.  Before the fix there
    // was ZERO `Criterion` anywhere in the project and no `retired` predicate
    // on any read.
    expect(repo, "the criterion fn is emitted").toContain("const liveCriterion = ()");
    expect(repo, "the base field lowers as a boolean column").toContain(
      "not(eq(schema.vehicles.retired, true))",
    );
    // Every root read AND-s it in — not just one of them.
    const applied = [...repo.matchAll(/liveCriterion\(\)/g)].length;
    expect(applied, "the filter is applied to findById, findManyByIds and all").toBeGreaterThan(2);
  });

  it("the predicate targets the shared TPH table, not the subtype's own plural", async () => {
    const files = await gen(hierarchy("this.doors > 0"));
    const repo = files.get("db/repositories/car-repository.ts") ?? "";
    expect(repo, "concrete repository emitted").not.toEqual("");
    // `schema.cars` is not exported by the generated schema at all under TPH —
    // the hierarchy has ONE table, `vehicles`.
    expect(repo, "no read references a subtype table object").not.toContain("schema.cars");
    const schema = files.get("db/schema.ts") ?? "";
    expect(schema, "the schema exports the shared base table").toContain("export const vehicles");
    expect(schema, "and exports no subtype table").not.toContain("export const cars");
  });

  it("a principal-referencing filter is also lowered against the shared table", async () => {
    // The tenancy shape: this is the one that produced 7 × TS2339, because a
    // principal filter never reifies to a criterion fn (no `currentUser` in a
    // module-level fn's scope) and therefore always inlines the table name.
    const files = await generateSystemFiles(`
      system Fleets {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain D {
          context Accounts {
            aggregate Org { title: string }
          }
          context Fleet {
            abstract aggregate Vehicle with tenantOwned {
              name: string
            }
            aggregate Car extends Vehicle with tenantOwned {
              doors: int
            }
            aggregate Truck extends Vehicle with tenantOwned {
              payloadKg: int
            }
            repository Cars for Car { }
            repository Trucks for Truck { }
          }
        }
        api A from D
        storage primary { type: postgres }
        resource fleetState { for: Fleet, kind: state, use: primary }
        resource accountsState { for: Accounts, kind: state, use: primary }
        deployable d {
          platform: node
          contexts: [Fleet, Accounts]
          dataSources: [fleetState, accountsState]
          serves: A
          port: 4000
          auth: required
        }
      }
    `);
    for (const [file, table] of [
      ["d/db/repositories/car-repository.ts", "cars"],
      ["d/db/repositories/truck-repository.ts", "trucks"],
    ] as const) {
      const repo = files.get(file) ?? "";
      expect(repo, `${file} emitted`).not.toEqual("");
      expect(repo, `${file} scopes by tenant on the shared table`).toContain(
        "eq(schema.vehicles.tenantId, requireCurrentUser().tenantId)",
      );
      expect(repo, `${file} must not name schema.${table}`).not.toContain(`schema.${table}`);
    }
  });

  it("the polymorphic base reader delegates, so it cannot bypass the concretes' filters", async () => {
    const files = await gen(hierarchy("!this.retired"));
    const base = files.get("db/repositories/vehicle-repository.ts") ?? "";
    expect(base, "base reader emitted").not.toEqual("");
    expect(base, "delegates to each concrete repository").toContain(
      "new CarRepository(db, events)",
    );
    // The whole point: no read of the shared table that is not routed through a
    // concrete repository (which carries the `kind` scope AND the filter).
    expect(base, "never selects from the shared table itself").not.toContain(
      "from(schema.vehicles)",
    );
  });
});
