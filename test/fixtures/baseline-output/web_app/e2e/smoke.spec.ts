// Auto-generated smoke spec.
import { test, expect } from "./fixtures";

test("ProductList loads", async ({ page }) => {
  await page.goto("/products");
  await expect(page).toHaveURL(new RegExp("/products$"));
});

test("ProductNew loads", async ({ page }) => {
  await page.goto("/products/new");
  await expect(page).toHaveURL(new RegExp("/products/new$"));
});

test("OrderList loads", async ({ page }) => {
  await page.goto("/orders");
  await expect(page).toHaveURL(new RegExp("/orders$"));
});

test("OrderNew loads", async ({ page }) => {
  await page.goto("/orders/new");
  await expect(page).toHaveURL(new RegExp("/orders/new$"));
});

test("PlaceOrderWorkflow loads", async ({ page }) => {
  await page.goto("/workflows/place_order");
  await expect(page).toHaveURL(new RegExp("/workflows/place_order$"));
});

test("CustomerList loads", async ({ page }) => {
  await page.goto("/customers");
  await expect(page).toHaveURL(new RegExp("/customers$"));
});

test("CustomerNew loads", async ({ page }) => {
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
