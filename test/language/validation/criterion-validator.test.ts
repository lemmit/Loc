// Validator coverage for `criterion` declarations + use sites.
// Diagnostic codes: loom.criterion-unsupported-target,
// loom.criterion-impure, loom.criterion-cycle, loom.criterion-arity.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const ctx = (body: string) => `
  context Sales {
    enum OrderStatus { Draft, Confirmed, Closed }
    aggregate Customer { active: bool  region: string }
    aggregate Order {
      status: OrderStatus
      operation close() { status := Closed }
    }
    repository Customers for Customer { }
    repository Orders for Order { }
    ${body}
  }
`;

describe("validator — criterion", () => {
  it("accepts aggregate-candidate and bool-candidate criteria", async () => {
    const { errors } = await parseString(
      ctx(`
        criterion ActiveCustomer of Customer = active
        criterion InRegion(r: string) of Customer = region == r
        criterion HasManagerRole of bool = currentUser.role == "manager"
      `),
    );
    expect(errors).toEqual([]);
  });

  it("accepts composition of criteria with && / || / !", async () => {
    const { errors } = await parseString(
      ctx(`
        criterion ActiveCustomer of Customer = active
        criterion InRegion(r: string) of Customer = region == r
        criterion Eligible of Customer = ActiveCustomer && InRegion("EU")
      `),
    );
    expect(errors).toEqual([]);
  });

  it("accepts an aliased candidate binder (`of T as o`)", async () => {
    const { errors } = await parseString(
      ctx(`criterion InRegion(r: string) of Customer as o = o.region == r`),
    );
    expect(errors).toEqual([]);
  });

  it("rejects an alias that collides with a parameter name (loom.criterion-alias-collision)", async () => {
    const { diagnostics } = await parseString(
      ctx(`criterion Bad(o: string) of Customer as o = region == o`),
    );
    expect(diagnostics.map((d) => d.code)).toContain("loom.criterion-alias-collision");
  });

  it("rejects an unsupported candidate type (`of decimal`)", async () => {
    const { errors } = await parseString(ctx(`criterion ValidAmount of decimal = active`));
    expect(errors.join("\n")).toMatch(/unsupported candidate type/);
  });

  it("rejects a body that calls a mutating operation", async () => {
    const { errors } = await parseString(ctx(`criterion Closeable of Order = close()`));
    expect(errors.join("\n")).toMatch(/impure.*operation 'close'/);
  });

  it("rejects a criterion reference cycle", async () => {
    const { errors } = await parseString(
      ctx(`
        criterion A of Customer = active && B
        criterion B of Customer = active && A
      `),
    );
    expect(errors.join("\n")).toMatch(/reference cycle/);
  });

  it("rejects an aggregate-criterion used against a different aggregate", async () => {
    const { errors } = await parseString(`
      context Sales {
        aggregate Customer { active: bool }
        aggregate Order { total: int }
        repository Customers for Customer { }
        repository Orders for Order {
          find bad(): Order[] where ActiveCustomer
        }
        criterion ActiveCustomer of Customer = active
      }
    `);
    expect(errors.join("\n")).toMatch(/is over 'Customer'.*used here against 'Order'/);
  });

  it("rejects a bare reference to a parameterised criterion", async () => {
    const { errors } = await parseString(
      ctx(`
        criterion InRegion(r: string) of Customer = region == r
        criterion Bad of Customer = InRegion
      `),
    );
    expect(errors.join("\n")).toMatch(/InRegion' expects 1 argument; reference it as/);
  });

  it("rejects a criterion call with the wrong argument count", async () => {
    const { errors } = await parseString(
      ctx(`
        criterion InRegion(r: string) of Customer = region == r
        criterion Bad of Customer = InRegion("EU", "extra")
      `),
    );
    expect(errors.join("\n")).toMatch(/InRegion' expects 1 argument, but 2/);
  });
});
