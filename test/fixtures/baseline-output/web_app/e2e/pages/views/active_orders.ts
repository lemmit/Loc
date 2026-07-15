// Auto-generated.  Do not edit by hand.
import type { Page } from "@playwright/test";

export interface ActiveOrdersRowText {
  customerId: string;
  status: string;
  placedAt: string;
  version: string;
}

export class ActiveOrdersViewPage {
  static readonly url = "/views/active_orders";
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<this> {
    await this.page.goto(ActiveOrdersViewPage.url);
    await this.page.getByTestId("view-active_orders").waitFor();
    return this;
  }

  async rows(): Promise<ActiveOrdersRowText[]> {
    const body = this.page.getByTestId("view-active_orders").locator("tbody tr");
    const n = await body.count();
    const out: ActiveOrdersRowText[] = [];
    for (let i = 0; i < n; i++) {
      const cells = body.nth(i).locator("td");
      const c_0 = (await cells.nth(0).innerText()).trim();
      const c_1 = (await cells.nth(1).innerText()).trim();
      const c_2 = (await cells.nth(2).innerText()).trim();
      const c_3 = (await cells.nth(3).innerText()).trim();
      out.push({ customerId: c_0, status: c_1, placedAt: c_2, version: c_3 });
    }
    return out;
  }

  async count(): Promise<number> {
    return this.page.getByTestId("view-active_orders").locator("tbody tr").count();
  }
}
