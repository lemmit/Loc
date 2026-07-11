// Auto-generated.  Do not edit by hand.
import type { Page } from "@playwright/test";

export interface OrderSummaryRowText {
  orderId: string;
  status: string;
  lineCount: string;
}

export class OrderSummaryViewPage {
  static readonly url = "/views/order_summary";
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<this> {
    await this.page.goto(OrderSummaryViewPage.url);
    await this.page.getByTestId("view-order_summary").waitFor();
    return this;
  }

  async rows(): Promise<OrderSummaryRowText[]> {
    const body = this.page.getByTestId("view-order_summary").locator("tbody tr");
    const n = await body.count();
    const out: OrderSummaryRowText[] = [];
    for (let i = 0; i < n; i++) {
      const cells = body.nth(i).locator("td");
      const c_0 = (await cells.nth(0).innerText()).trim();
      const c_1 = (await cells.nth(1).innerText()).trim();
      const c_2 = (await cells.nth(2).innerText()).trim();
      out.push({ orderId: c_0, status: c_1, lineCount: c_2 });
    }
    return out;
  }

  async count(): Promise<number> {
    return this.page.getByTestId("view-order_summary").locator("tbody tr").count();
  }
}
