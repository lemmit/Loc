// Parsing + lowering for the M-T2.3 `migration`-block data steps:
// backfill (`Agg.field = <expr>`) and raw `sql "…"`, alongside the shipped
// M-T2.1 renames.  The `sql` keyword is soft — a domain field named `sql`
// keeps parsing (keyword-identifier-completeness pins the positions).

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { parseString } from "../../_helpers/parse.js";

const SYS = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Pending, Confirmed }
      aggregate Order { quantity: int  status: OrderStatus  firstName: string  lastName: string }
      repository Orders for Order { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
`;

describe("migration data steps — parsing + lowering (M-T2.3)", () => {
  it("parses and lowers a backfill step with the expression in aggregate scope", async () => {
    const { model, diagnostics } = await parseString(
      `${SYS}
migration "backfill-status" {
  Order.status = Pending
  Order.firstName = firstName + " "
}`,
      { validate: false },
    );
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
    const loom = lowerModel(model);
    expect(loom.backfillIntents).toHaveLength(2);
    const [status, first] = loom.backfillIntents;
    expect(status).toMatchObject({
      migration: "backfill-status",
      aggregate: "Order",
      context: "Orders",
      field: "status",
    });
    expect(status!.value).toMatchObject({ kind: "ref", refKind: "enum-value", name: "Pending" });
    // Sibling-field ref lowers as a this-prop — the SQL renderer's column ref.
    expect(first!.value).toMatchObject({
      kind: "binary",
      op: "+",
      left: { kind: "ref", refKind: "this-prop", name: "firstName" },
    });
    expect(loom.sqlMigrationSteps).toEqual([]);
  });

  it("parses and lowers sql steps with their block-declaration index", async () => {
    const { model, diagnostics } = await parseString(
      `${SYS}
migration "fixup" {
  Order.qty -> quantity
  sql "UPDATE orders SET quantity = 0 WHERE quantity IS NULL"
  sql "ANALYZE orders"
}`,
      { validate: false },
    );
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
    const loom = lowerModel(model);
    expect(loom.renameIntents).toHaveLength(1);
    expect(loom.renameIntents[0]).toMatchObject({ from: "qty", to: "quantity" });
    expect(loom.sqlMigrationSteps).toEqual([
      expect.objectContaining({
        migration: "fixup",
        index: 1,
        sql: "UPDATE orders SET quantity = 0 WHERE quantity IS NULL",
      }),
      expect.objectContaining({ migration: "fixup", index: 2, sql: "ANALYZE orders" }),
    ]);
  });

  it("keeps `sql` usable as an ordinary field name (soft keyword)", async () => {
    const { diagnostics } = await parseString(
      `
context Reports {
  aggregate Query { sql: string }
  repository Queries for Query { }
}`,
      { validate: false },
    );
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });
});
