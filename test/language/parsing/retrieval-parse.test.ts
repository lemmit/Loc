// Grammar coverage for the `retrieval` declaration (the named query
// bundle — retrieval.md).  Single-line `= <expr>` form, the full block
// with `where` / `sort` / `loads` slots, parameters, and the
// soft-keyword admission of `sort` / `loads` / `asc` / `desc` /
// `retrieval` as ordinary field names.

import { describe, expect, it } from "vitest";
import { isBoundedContext, isRetrieval } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

describe("parsing — retrieval declaration", () => {
  it("parses single-line, where-only, and full-slot forms", async () => {
    const { model, errors } = await parseString(`
      context Sales {
        aggregate Customer { active: bool  region: string  name: string }
        repository Customers for Customer { }

        criterion ActiveCustomer of Customer = active
        criterion InRegion(region: string) of Customer = region == region

        retrieval AllActive of Customer = ActiveCustomer

        retrieval WhereOnly of Customer { where: ActiveCustomer }

        retrieval ActiveInRegion(region: string) of Customer {
          where: ActiveCustomer && InRegion(region)
          sort:  [name asc]
          loads: [this.region]
        }
      }
    `);
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const retrievals = ctx.members.filter(isRetrieval);
    expect(retrievals.map((r) => r.name)).toEqual(["AllActive", "WhereOnly", "ActiveInRegion"]);
    expect(retrievals[2]!.params.map((p) => p.name)).toEqual(["region"]);
    expect(retrievals[2]!.sort.map((s) => s.direction)).toEqual(["asc"]);
    expect(retrievals[2]!.loads).toHaveLength(1);
  });

  it("parses multi-term sort with directions and a multi-segment collection load path", async () => {
    const { model, errors } = await parseString(`
      context Sales {
        aggregate Order { total: decimal  createdAt: string }
        repository Orders for Order { }

        criterion HighValue of Order = total > 1000

        retrieval TopOrders of Order {
          where: HighValue
          sort:  [total desc, createdAt asc]
          loads: [this.lines[].product, this.customer]
        }
      }
    `);
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const r = ctx.members.filter(isRetrieval)[0]!;
    expect(r.sort.map((s) => s.direction)).toEqual(["desc", "asc"]);
    // first load path: this.lines[].product — collection marker on `lines`
    const firstPath = r.loads[0]!;
    expect(firstPath.segments.map((s) => s.name)).toEqual(["lines", "product"]);
    expect(firstPath.segments[0]!.collection).toBe(true);
    expect(firstPath.segments[1]!.collection).toBeFalsy();
  });

  it("admits sort / loads / asc / desc / retrieval as ordinary field names (soft keywords)", async () => {
    const { errors } = await parseString(`
      context Sales {
        aggregate Thing {
          sort: string
          loads: int
          asc: bool
          desc: bool
          retrieval: string
        }
        repository Things for Thing { }
      }
    `);
    expect(errors).toEqual([]);
  });
});
