// Auto-generated smoke spec.
import { test, expect } from "./fixtures";

test("Products List loads", async ({ page }) => {
  await page.goto("/products");
  await expect(page).toHaveURL(new RegExp("/products$"));
});

test("Products New loads", async ({ page }) => {
  await page.goto("/products/new");
  await expect(page).toHaveURL(new RegExp("/products/new$"));
});

test("Orders List loads", async ({ page }) => {
  await page.goto("/orders");
  await expect(page).toHaveURL(new RegExp("/orders$"));
});

test("Orders New loads", async ({ page }) => {
  await page.goto("/orders/new");
  await expect(page).toHaveURL(new RegExp("/orders/new$"));
});

test("PlaceOrderWorkflow loads", async ({ page }) => {
  await page.goto("/workflows/place_order");
  await expect(page).toHaveURL(new RegExp("/workflows/place_order$"));
});

test("ActiveOrdersView loads", async ({ page }) => {
  await page.goto("/views/active_orders");
  await expect(page).toHaveURL(new RegExp("/views/active_orders$"));
});

test("OrderSummaryView loads", async ({ page }) => {
  await page.goto("/views/order_summary");
  await expect(page).toHaveURL(new RegExp("/views/order_summary$"));
});

test("Customers List loads", async ({ page }) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(new RegExp("/customers$"));
});

test("Customers New loads", async ({ page }) => {
  await page.goto("/customers/new");
  await expect(page).toHaveURL(new RegExp("/customers/new$"));
});

test("Home loads", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(new RegExp("/$"));
});

test("WorkflowsIndex loads", async ({ page }) => {
  await page.goto("/workflows");
  await expect(page).toHaveURL(new RegExp("/workflows$"));
});

test("ViewsIndex loads", async ({ page }) => {
  await page.goto("/views");
  await expect(page).toHaveURL(new RegExp("/views$"));
});
