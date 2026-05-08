// Auto-generated.  Do not edit by hand.
import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { CreateOrderRequest, AddLineRequest, ConfirmRequest, OrderResponse } from "../../src/api/order";

export class OrderListPage {
  static readonly url = "/orders";
  constructor(public readonly page: Page) {}

  async goto(): Promise<this> {
    await this.page.goto(OrderListPage.url);
    await this.page.getByTestId("orders-list").waitFor();
    return this;
  }

  async create(): Promise<OrderNewPage> {
    await this.page.getByTestId("orders-list-create").click();
    return new OrderNewPage(this.page);
  }

  row(id: string): Locator {
    return this.page.getByTestId(`orders-row-${id}`);
  }

  async open(id: string): Promise<OrderDetailPage> {
    await this.page.getByTestId(`orders-row-${id}-link`).click();
    await this.page.waitForURL(new RegExp(`/orders/${id}$`));
    return new OrderDetailPage(this.page, id);
  }

  async expectRow(id: string): Promise<void> {
    await expect(this.row(id)).toBeVisible();
  }
}

export class OrderNewPage {
  static readonly url = "/orders/new";
  constructor(public readonly page: Page) {}

  async goto(): Promise<this> {
    await this.page.goto(OrderNewPage.url);
    await this.page.getByTestId("orders-new").waitFor();
    return this;
  }

  async fill(input: Partial<CreateOrderRequest>): Promise<this> {
    if (input.customerId !== undefined) {
      await this.page.getByTestId("orders-new-input-customerId").fill(input.customerId!);
    }
    if (input.status !== undefined) {
      {
        const __sel = this.page.getByTestId("orders-new-input-status");
        await __sel.click();
        const __listbox = this.page.locator('[role="listbox"]').filter({ has: this.page.getByRole("option", { name: input.status!, exact: true }) });
        await __listbox.waitFor({ state: "visible" });
        await __listbox.getByRole("option", { name: input.status!, exact: true }).click();
      }
    }
    if (input.placedAt !== undefined) {
      await this.page.getByTestId("orders-new-input-placedAt").fill(input.placedAt!.slice(0, 19));
    }
    return this;
  }

  async submit(): Promise<OrderDetailPage> {
    await this.page.getByTestId("orders-new-submit").click();
    // Wait for the detail page to render rather than matching
    // the URL — `/orders/new` itself matches a naive regex.
    await this.page.getByTestId("orders-detail").waitFor();
    const id = this.page.url().split("/").pop()!;
    return new OrderDetailPage(this.page, id);
  }
}

export class OrderDetailPage {
  constructor(public readonly page: Page, public readonly id: string) {}

  async goto(): Promise<this> {
    await this.page.goto(`/orders/${this.id}`);
    await this.page.getByTestId("orders-detail").waitFor();
    return this;
  }

  /** Read a primitive / enum field as displayed text. */
  async field<K extends keyof OrderResponse>(name: K): Promise<string> {
    return await this.page.getByTestId(`orders-detail-${String(name)}`).innerText();
  }

  /** Locator for the row of the contained `lines` collection. */
  linesRow(id: string): Locator {
    return this.page.getByTestId(`orders-detail-lines-row-${id}`);
  }

  /** Count of rows in the contained `lines` table. */
  async linesCount(): Promise<number> {
    return await this.page.getByTestId("orders-detail-lines").locator("tbody tr").count();
  }

  /** addLine — opens the modal, fills the form, submits. */
  async addLine(input: AddLineRequest): Promise<this> {
    await this.page.getByTestId("orders-op-addLine").click();
    await this.page.getByTestId("orders-op-addLine-form").waitFor();
    if (input.productId !== undefined) {
      {
        await this.page.getByTestId("orders-op-addLine-input-productId").click();
        const __opt = this.page.getByTestId(`orders-op-addLine-input-productId-option-${input.productId!}`);
        await __opt.waitFor({ state: "visible" });
        await __opt.click();
      }
    }
    if (input.qty !== undefined) {
      await this.page.getByTestId("orders-op-addLine-input-qty").fill(String(input.qty));
    }
    await this.page.getByTestId("orders-op-addLine-submit").click();
    await this.page.getByTestId("orders-op-addLine-form").waitFor({ state: "detached" });
    return this;
  }

  /** confirm (no parameters). */
  async confirm(): Promise<this> {
    await this.page.getByTestId("orders-op-confirm").click();
    await this.page.getByTestId("orders-op-confirm-submit").click();
    await this.page.getByTestId("orders-op-confirm-form").waitFor({ state: "detached" });
    return this;
  }

}
