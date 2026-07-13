// Projection-sourced views on Java (projection.md v1.1): a `view` over a
// projection reads its `<Proj>Row` through the Spring Data `<Proj>RowRepository`,
// filters in-memory over the row accessors, and projects each row into a
// `<View>Row` record.  Shorthand + follow-free full-form compile; a
// cross-aggregate bind-follow shares the aggregate backend's limitation (thrown).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const SRC = (view: string) => `
  system Shop {
    subdomain Sales {
      context Orders {
        enum OrderStatus { Placed, Shipped }
        event OrderPlaced  { order: Order id, customer: Customer id }
        event OrderShipped { order: Order id }
        aggregate Customer { name: string }
        repository Customers for Customer {}
        aggregate Order { status: OrderStatus  customer: Customer id }
        repository Orders for Order {}
        projection OrderBook keyed by order {
          order: Order id
          customer: Customer id
          status: OrderStatus
          on(e: OrderPlaced)  { order := e.order  customer := e.customer  status := Placed }
          on(e: OrderShipped) { status := Shipped }
        }
        ${view}
      }
    }
    storage primary { type: postgres }
    deployable api { platform: java  contexts: [Orders]  port: 3000 }
  }
`;

async function gen(view: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SRC(view));
  if (errors.length) throw new Error(errors.join("\n"));
  return generateSystems(model).files;
}

const find = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([k]) => k.endsWith(suffix))?.[1];

describe("java projection-sourced views", () => {
  it("reads the <Proj>RowRepository and projects into a <View>Row (shorthand)", async () => {
    const files = await gen("view ShippedRows = OrderBook where status == Shipped");
    const svc = find(files, "OrdersViews.java")!;
    expect(svc).toContain("private final OrderBookRowRepository orderBookRowRepository;");
    expect(svc).toContain("orderBookRowRepository.findAll().stream()");
    expect(svc).toContain(".filter(x -> x.status() == OrderStatus.Shipped)");
    expect(svc).toContain(
      "new ShippedRowsRow(x.order().value(), x.customer().value(), x.status())",
    );
    const row = find(files, "ShippedRowsRow.java")!;
    expect(row).toContain("public record ShippedRowsRow(");
  });

  it("projects a follow-free full-form bind over the row column", async () => {
    const files = await gen(
      `view ShippedLabels {
        label: OrderStatus
        from OrderBook where status == Shipped
        bind label = status
      }`,
    );
    const svc = find(files, "OrdersViews.java")!;
    expect(svc).toContain("new ShippedLabelsRow(x.status())");
  });

  it("throws on a cross-aggregate bind-follow (shared aggregate-backend limitation)", async () => {
    await expect(
      gen(
        `view ShippedOrders {
          customerName: string
          from OrderBook where status == Shipped
          bind customerName = customer.name
        }`,
      ),
    ).rejects.toThrow(/cross-aggregate follows/);
  });
});
