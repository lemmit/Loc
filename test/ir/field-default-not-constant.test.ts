import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T9.24 G1 — a field `= default` must be instance-INDEPENDENT.
//
// A default is not a body: it is spliced into contexts where no instance
// exists, most visibly the CREATE-REQUEST wire schema.  Before this gate,
// `avgPrice: decimal = this.total / this.count` emitted
//
//   Hono    z.coerce.number().default(this.total / this.count)   at MODULE
//           scope — TS2683 plus a TypeError on import, so the server never
//           boots (reproduced with the CLI);
//   Python  `avg_price: Decimal = self.total / self.count` in a pydantic
//           class body — NameError at import;
//   .NET    the default was silently DROPPED, quietly turning the field into
//   Java    a REQUIRED create input.
//
// Two boot-breaks and a silent contract change from one accepted model.  A
// value computed from other fields is a `derived`, which is what the message
// says.
// ---------------------------------------------------------------------------

const system = (body: string) => `
system DefProbe {
  subdomain Ops {
    context Ops {
      ${body}
      repository Metrics for Metric { }
    }
  }
  api OpsApi from Ops
  storage primary { type: postgres }
  resource opsState { for: Ops, kind: state, use: primary }
  deployable svc {
    platform: node
    contexts: [Ops]
    dataSources: [opsState]
    serves: OpsApi
    port: 4000
  }
}
`;

async function errorsFor(body: string): Promise<string[]> {
  const model = await parseValid(system(body));
  return validateLoomModel(enrichLoomModel(lowerModel(model))).map(
    (d) => `${d.code ?? ""} ${d.message}`,
  );
}

describe("loom.field-default-not-constant", () => {
  it("rejects a default that reads another field", async () => {
    const errors = await errorsFor(`
      aggregate Metric with crudish {
        total: int
        count: int
        avgPrice: decimal = this.total / this.count
      }
    `);
    expect(errors.join("\n")).toContain("Metric.avgPrice");
    expect(errors.join("\n")).toContain("this.total");
    expect(errors.join("\n")).toContain("derived avgPrice");
  });

  it("rejects a default that calls an instance function", async () => {
    const errors = await errorsFor(`
      aggregate Metric with crudish {
        total: int
        count: int
        avgPrice: int = half()
        function half(): int { return total }
      }
    `);
    expect(errors.join("\n")).toMatch(/default for 'Metric\.avgPrice'/);
  });

  it("accepts instance-independent defaults", async () => {
    // Literals, `now`, and enum values all resolve with no instance and every
    // backend renders them in its native default slot.
    const errors = await errorsFor(`
      enum Tier { free, paid }
      aggregate Metric with crudish {
        total: int = 0
        label: string = "unset"
        active: bool = true
        tier: Tier = Tier.free
        createdAt: datetime = now()
        count: int
      }
    `);
    expect(errors).toEqual([]);
  });

  it("catches the same shape on an entity part and a value object", async () => {
    const part = await errorsFor(`
      aggregate Metric with crudish {
        total: int
        contains lines: Line[]
        entity Line { qty: int  doubled: int = this.qty }
      }
    `);
    expect(part.join("\n")).toContain("Line.doubled");

    const vo = await errorsFor(`
      valueobject Span {
        from2: int
        to2: int
        width: int = this.to2
      }
      aggregate Metric with crudish {
        total: int
      }
    `);
    expect(vo.join("\n")).toContain("Span.width");
  });
});
