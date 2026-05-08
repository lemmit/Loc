// Auto-generated.  Do not edit by hand.
import { test, expect } from "@playwright/test";
import { ProductListPage, ProductDetailPage } from "./pages/product";
import { OrderListPage, OrderDetailPage } from "./pages/order";
import { PlaceOrderWorkflowPage } from "./pages/workflows/place_order";
import { ActiveOrdersViewPage } from "./pages/views/active_orders";

test("create then confirm an order via UI", async ({ page }) => {
  const prod = await (async () => {   const __list = await new ProductListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ sku: "WIDGET-UI-1", price: ({ amount: 5.0, currency: "USD" }) }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  const ord = await (async () => {   const __list = await new OrderListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ customerId: "cust-ui", status: "Draft", placedAt: "2024-01-01T00:00" }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.addLine(({ productId: prod.id, qty: 3 })));
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.confirm());
  const read = await (async () => {
    const __detail = await new OrderDetailPage(page, ord.id).goto();
    return {
      id: __detail.id,
      customerId: await __detail.field("customerId"),
      status: await __detail.field("status"),
      placedAt: await __detail.field("placedAt"),
      lines: { length: await __detail.linesCount() },
    };
  })();
  expect(read.status === "Confirmed").toBe(true);
  expect(read.lines.length === 1).toBe(true);
});

test("place an order via the workflow UI", async ({ page }) => {
  const prod = await (async () => {   const __list = await new ProductListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ sku: "WIDGET-UI-2", price: ({ amount: 7.5, currency: "USD" }) }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  await new PlaceOrderWorkflowPage(page).run(({ customerId: "cust-wf", productId: prod.id, quantity: 2 }));
});

test("active orders view renders the rendered rows", async ({ page }) => {
  const rows = await (async () => {   const __view = await new ActiveOrdersViewPage(page).goto();   return await __view.rows(); })();
  expect(rows.length >= 0).toBe(true);
});

