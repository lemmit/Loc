// Auto-generated smoke spec.
import { test, expect } from "@playwright/test";
import { ProductListPage } from "./pages/product";
import { OrderListPage } from "./pages/order";
import { CustomerListPage } from "./pages/customer";

test("products list loads", async ({ page }) => {
  const p = await new ProductListPage(page).goto();
  await expect(p.page).toHaveURL(/products$/);
});

test("orders list loads", async ({ page }) => {
  const p = await new OrderListPage(page).goto();
  await expect(p.page).toHaveURL(/orders$/);
});

test("customers list loads", async ({ page }) => {
  const p = await new CustomerListPage(page).goto();
  await expect(p.page).toHaveURL(/customers$/);
});
