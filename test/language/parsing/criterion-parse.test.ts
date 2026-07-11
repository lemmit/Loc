// Grammar coverage for the `criterion` declaration (Specification
// Pattern).  Both the single-line `= <expr>` form and the block
// `{ where: <expr> }` form, with and without parameters.

import { describe, expect, it } from "vitest";
import { isBoundedContext, isCriterion } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

describe("parsing — criterion declaration", () => {
  it("parses parameterless, parameterised, block, and bool-candidate forms", async () => {
    const { model, errors } = await parseString(`
      context Sales {
        enum OrderStatus { Draft, Confirmed, Closed }
        aggregate Customer { active: bool  region: string }
        aggregate Order { status: OrderStatus }
        repository Customers for Customer { }
        repository Orders for Order { }

        criterion ActiveCustomer of Customer = active
        criterion InRegion(region: string) of Customer = region == region
        criterion HasManagerRole of bool = currentUser.role == "manager"
        criterion CanForceClose of Order = status != Closed
      }
    `);
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const criteria = ctx.members.filter(isCriterion);
    expect(criteria.map((c) => c.name)).toEqual([
      "ActiveCustomer",
      "InRegion",
      "HasManagerRole",
      "CanForceClose",
    ]);
    expect(criteria[1]!.params.map((p) => p.name)).toEqual(["region"]);
  });

  it("admits a composed criterion declaration (`A && B`)", async () => {
    const { errors } = await parseString(`
      context Sales {
        aggregate Customer { active: bool  region: string }
        repository Customers for Customer { }
        criterion ActiveCustomer of Customer = active
        criterion InRegion(region: string) of Customer = region == region
        criterion EligibleEu of Customer = ActiveCustomer && InRegion("EU")
      }
    `);
    expect(errors).toEqual([]);
  });
});
