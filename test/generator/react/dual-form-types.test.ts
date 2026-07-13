// Frontend-ACL Phase 3, realized as "keep nested, transform only"
// (maintainer decision 2026-06-12): the dual FormState (`z.input`) /
// Payload (`z.output`) aliases emit ONLY for actions whose request
// schema carries a real transform — today that is exactly the `money`
// primitive (`moneySchema`: decimal string → Decimal), reached directly,
// through array/optional wrappers, or inside a value object.  Actions
// without a transform keep the single `<Action>Request` type;
// structurally identical aliases would be noise.
//
// The original flat-dot-key half of the Phase 3 spec is unimplementable
// as written: react-hook-form always interprets dots in field names as
// nesting, so a flat-keyed schema would reject the nested runtime values
// RHF produces.  Recorded in docs/old/plans/frontend-acl-implementation.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
  system S {
    subdomain Sub { context Sales {
      valueobject Price { amount: money  currency: string }
      aggregate Order with crudish {
        total: money
        note: string
        operation discount(amount: money) { total := total - amount }
        operation rename(label: string) { note := label }
      }
      repository Orders for Order { }
      aggregate Quote with crudish { cost: Price }
      repository Quotes for Quote { }
      aggregate Tag with crudish { label: string }
      repository Tags for Tag { }
    } }
    api SalesApi from Sub
    ui WebApp with scaffold(subdomains: [Sub]) { api Sub: SalesApi }
    deployable api { platform: node, contexts: [Sales], serves: SalesApi, port: 3000 }
    deployable web { platform: static, targets: api, ui: WebApp { Sub: api }, port: 3001 }
  }
`;

describe("dual FormState/Payload types — transform-bearing actions only", () => {
  it("a money-bearing create + operation gain z.input/z.output aliases", async () => {
    const files = await generateSystemFiles(SRC);
    const order = files.get("web/src/api/order.ts")!;
    expect(order).toContain(
      "export type CreateOrderFormState = z.input<typeof CreateOrderRequest>;",
    );
    expect(order).toContain(
      "export type CreateOrderPayload = z.output<typeof CreateOrderRequest>;",
    );
    expect(order).toContain(
      "export type DiscountOrderFormState = z.input<typeof DiscountOrderRequest>;",
    );
    expect(order).toContain(
      "export type DiscountOrderPayload = z.output<typeof DiscountOrderRequest>;",
    );
  });

  it("money inside a value object also gates the aliases", async () => {
    const files = await generateSystemFiles(SRC);
    const quote = files.get("web/src/api/quote.ts")!;
    expect(quote).toContain(
      "export type CreateQuoteFormState = z.input<typeof CreateQuoteRequest>;",
    );
  });

  it("transform-less actions keep the single Request type (no noise aliases)", async () => {
    const files = await generateSystemFiles(SRC);
    const order = files.get("web/src/api/order.ts")!;
    expect(order).not.toContain("RenameOrderFormState");
    expect(order).not.toContain("RenameOrderPayload");
    const tag = files.get("web/src/api/tag.ts")!;
    expect(tag).not.toContain("FormState");
    expect(tag).not.toContain("Payload =");
  });
});
