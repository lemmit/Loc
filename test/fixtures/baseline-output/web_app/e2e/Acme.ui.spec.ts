// Auto-generated.  Do not edit by hand.
import { test, expect } from "./fixtures";
import { ProductListPage } from "./pages/product";
import { OrderListPage, OrderDetailPage } from "./pages/order";
import { PlaceOrderWorkflowPage } from "./pages/workflows/place_order";

test("create then confirm an order via UI", async ({ page }) => {
  const prod = await (async () => {   const __list = await new ProductListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ sku: "WIDGET-UI-1", price: ({ amount: 5.0, currency: "USD" }) }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  const ord = await (async () => {   const __list = await new OrderListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ customerId: "cust-ui", status: "Draft", placedAt: "2024-01-01T00:00" }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.addLine(({ productId: prod.id, qty: 3 })));
  await new OrderDetailPage(page, ord.id).goto().then((__d) => __d.confirm());
  const read = await new OrderDetailPage(page, ord.id).goto();
  await expect(read.field("status")).toHaveText("Confirmed");
  await expect(read.linesRows()).toHaveCount(1);
});

test("place an order via the workflow UI", async ({ page }) => {
  const prod = await (async () => {   const __list = await new ProductListPage(page).goto();   const __new = await __list.create();   await __new.fill(({ sku: "WIDGET-UI-2", price: ({ amount: 7.5, currency: "USD" }) }));   const __detail = await __new.submit();   return { id: __detail.id }; })();
  await new PlaceOrderWorkflowPage(page).run(({ customerId: "cust-wf", productId: prod.id, quantity: 2 }));
});

