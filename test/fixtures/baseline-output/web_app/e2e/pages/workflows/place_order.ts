// Auto-generated.  Do not edit by hand.
import type { Page } from "@playwright/test";
import type { PlaceOrderRequest } from "../../../src/api/workflows";

export class PlaceOrderWorkflowPage {
  static readonly url = "/workflows/place_order";
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<this> {
    await this.page.goto(PlaceOrderWorkflowPage.url);
    await this.page.getByTestId("workflow-place_order").waitFor();
    return this;
  }

  async fill(input: Partial<PlaceOrderRequest>): Promise<this> {
    if (input.customerId !== undefined) {
      {
        const __f = this.page.getByTestId("workflow-place_order-input-customerId");
        const __i = __f.locator("input, textarea");
        await ((await __i.count()) ? __i.first() : __f).fill(input.customerId!);
      }
    }
    if (input.productId !== undefined) {
      {
        await this.page.getByTestId("workflow-place_order-input-productId").click();
        const __opt = this.page.getByTestId(`workflow-place_order-input-productId-option-${input.productId!}`);
        await __opt.waitFor({ state: "visible" });
        await __opt.click();
      }
    }
    if (input.quantity !== undefined) {
      {
        const __f = this.page.getByTestId("workflow-place_order-input-quantity");
        const __i = __f.locator("input, textarea");
        await ((await __i.count()) ? __i.first() : __f).fill(String(input.quantity));
      }
    }
    return this;
  }

  async submit(): Promise<void> {
    await this.page.getByTestId("workflow-place_order-submit").click();
    await this.page.waitForURL(/\/workflows$/);
  }

  async run(input: PlaceOrderRequest): Promise<void> {
    await this.goto();
    await this.fill(input);
    await this.submit();
  }
}
