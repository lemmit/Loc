import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

// Parameter defaults get the same type-check as field defaults
// (`checkParameterDefault`) — a mistyped default errors at the source instead
// of silently seeding a wrong-typed form value.

const SYS = (agg: string) => `
system S {
  subdomain M {
    context C {
      aggregate Shipment {
        eta:    datetime
        status: string
        ${agg}
      }
      repository Shipments for Shipment { }
    }
  }
}
`;

describe("parameter default type-check", () => {
  it("rejects a default whose type doesn't match the parameter", async () => {
    const { errors } = await parseString(
      SYS(`operation cancel(reason: int = "not an int") { status := "x" }`),
    );
    expect(errors.join("\n")).toMatch(/Default for parameter 'reason'.*int/);
  });

  it("accepts a constant default of the right type", async () => {
    const { errors } = await parseString(
      SYS(`operation cancel(reason: string = "customer request") { status := reason }`),
    );
    expect(errors.filter((e) => /Default for parameter/.test(e))).toEqual([]);
  });

  it("accepts a this-relative default that resolves against the aggregate", async () => {
    const { errors } = await parseString(
      SYS(`operation reschedule(to: datetime = this.eta) { eta := to }`),
    );
    expect(errors.filter((e) => /Default for parameter/.test(e))).toEqual([]);
  });
});
