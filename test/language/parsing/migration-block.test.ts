// Parsing coverage for the `migration { rename ... }` block (M-T2.1).
// The block is a top-level ModelMember, isolated from the domain model; its
// `rename Agg.old -> new` steps reference a real aggregate (cross-reference).

import { describe, expect, it } from "vitest";
import { isMigration } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

const MODEL = (migration: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        quantity: int
        fulfilledAt: datetime
      }
      repository Orders for Order { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
${migration}
`;

describe("migration block — parsing", () => {
  it("parses a `migration` block with multiple rename steps", async () => {
    const { model, errors } = await parseString(
      MODEL(`
migration "rename-order-fields" {
  Order.qty -> quantity
  Order.shippedAt -> fulfilledAt
}
`),
    );
    expect(errors).toEqual([]);
    const block = model.members.find(isMigration);
    expect(block?.name).toBe("rename-order-fields");
    expect(block?.renames.map((r) => `${r.aggregate.$refText}.${r.from}->${r.to}`)).toEqual([
      "Order.qty->quantity",
      "Order.shippedAt->fulfilledAt",
    ]);
  });

  it("keeps `migration` usable as an ordinary field / operation name (soft keyword; step is keyword-free)", async () => {
    const { errors } = await parseString(`
context C {
  aggregate A {
    migration: string
    operation rename(v: string) { migration := v }
  }
  repository As for A { }
}
`);
    expect(errors).toEqual([]);
  });

  it("an empty migration block parses", async () => {
    const { errors } = await parseString(MODEL(`migration "noop" { }`));
    expect(errors).toEqual([]);
  });
});
