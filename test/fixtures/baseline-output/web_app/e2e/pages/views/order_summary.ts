// Auto-generated.  Do not edit by hand.
import type { Page } from "@playwright/test";

export interface OrderSummaryRowText {
  orderId: string;
  status: string;
  lineCount: string;
}

export class OrderSummaryViewPage {
  static readonly url = "/views/order_summary";
  constructor(public readonly page: Page) {}

  async goto(): Promise<this> {
    await this.page.goto(OrderSummaryViewPage.url);
    await this.page.getByTestId("view-order_summary").waitFor();
    return this;
  }

  async rows(): Promise<OrderSummaryRowText[]> {
    const out: OrderSummaryRowText[] = [];
    for (let i = 0; i < 1000; i++) {
      const row = this.page.getByTestId(`view-order_summary-row-${i}`);
      if ((await row.count()) === 0) break;
      const c_orderId = await this.page.getByTestId(`view-order_summary-row-${i}-orderId`).innerText();
      const c_status = await this.page.getByTestId(`view-order_summary-row-${i}-status`).innerText();
      const c_lineCount = await this.page.getByTestId(`view-order_summary-row-${i}-lineCount`).innerText();
      out.push({ orderId: c_orderId, status: c_status, lineCount: c_lineCount });
    }
    return out;
  }

  async count(): Promise<number> {
    return (await this.rows()).length;
  }
}
