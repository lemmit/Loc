// IR-level validator coverage for `retrieval` (retrieval.md).  The
// `where` slot is a selection position (same queryable-subset contract
// as a `find … where`); `sort` / `loads` paths must resolve against the
// candidate aggregate.

import { describe, expect, it } from "vitest";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/index.js";

const wrap = (body: string) => `
  context Sales {
    aggregate Customer {
      active: bool
      region: string
      name: string
      tags: string
    }
    repository Customers for Customer { }
    criterion ActiveCustomer of Customer = active
    criterion InRegion(rgn: string) of Customer = region == rgn
    ${body}
  }
`;

async function diagsFor(body: string) {
  const loom = await buildLoomModel(wrap(body));
  return validateLoomModel(loom).filter((d) => d.source.includes("retrieval"));
}

describe("validator — retrieval", () => {
  it("accepts a well-formed retrieval (composed where + valid sort + valid loads)", async () => {
    const diags = await diagsFor(`
      retrieval ActiveInRegion(region: string) of Customer {
        where: ActiveCustomer && InRegion(region)
        sort:  [name asc]
        loads: [this.region]
      }
    `);
    expect(diags).toEqual([]);
  });

  it("accepts the single-line and where-only forms", async () => {
    const diags = await diagsFor(`
      retrieval AllActive of Customer = ActiveCustomer
      retrieval WhereOnly of Customer { where: InRegion("EU") }
    `);
    expect(diags).toEqual([]);
  });

  it("rejects a non-queryable where (a method call cannot lower to SQL)", async () => {
    const diags = await diagsFor(`
      retrieval BadWhere of Customer { where: region.matches("x") }
    `);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0]!.message).toMatch(/not queryable/);
    expect(diags[0]!.source).toContain("retrieval BadWhere");
  });

  it("rejects a sort over an unknown field", async () => {
    const diags = await diagsFor(`
      retrieval BadSort of Customer {
        where: ActiveCustomer
        sort:  [nope desc]
      }
    `);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags.some((d) => /sort references unknown field 'nope'/.test(d.message))).toBe(true);
  });

  it("rejects a loads path whose first segment is not an aggregate member", async () => {
    const diags = await diagsFor(`
      retrieval BadLoads of Customer {
        where: ActiveCustomer
        loads: [this.ghost]
      }
    `);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags.some((d) => /loads references unknown field 'ghost'/.test(d.message))).toBe(true);
  });
});
