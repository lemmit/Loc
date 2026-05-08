// Auto-generated.  Do not edit by hand.
import type { Page } from "@playwright/test";

export interface ActiveOrdersRowText {
  id: string;
  customerId: string;
  status: string;
  placedAt: string;
}

export class ActiveOrdersViewPage {
  static readonly url = "/views/active_orders";
  constructor(public readonly page: Page) {}

  async goto(): Promise<this> {
    await this.page.goto(ActiveOrdersViewPage.url);
    await this.page.getByTestId("view-active_orders").waitFor();
    return this;
  }

  async rows(): Promise<ActiveOrdersRowText[]> {
    const out: ActiveOrdersRowText[] = [];
    for (let i = 0; i < 1000; i++) {
      const row = this.page.getByTestId(`view-active_orders-row-${i}`);
      if ((await row.count()) === 0) break;
      const c_id = await this.page.getByTestId(`view-active_orders-row-${i}-id`).innerText();
      const c_customerId = await this.page.getByTestId(`view-active_orders-row-${i}-customerId`).innerText();
      const c_status = await this.page.getByTestId(`view-active_orders-row-${i}-status`).innerText();
      const c_placedAt = await this.page.getByTestId(`view-active_orders-row-${i}-placedAt`).innerText();
      out.push({ id: c_id, customerId: c_customerId, status: c_status, placedAt: c_placedAt });
    }
    return out;
  }

  async count(): Promise<number> {
    return (await this.rows()).length;
  }
}
