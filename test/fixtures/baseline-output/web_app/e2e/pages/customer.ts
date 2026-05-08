// Auto-generated.  Do not edit by hand.
import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { CreateCustomerRequest, CustomerResponse } from "../../src/api/customer";

export class CustomerListPage {
  static readonly url = "/customers";
  constructor(public readonly page: Page) {}

  async goto(): Promise<this> {
    await this.page.goto(CustomerListPage.url);
    await this.page.getByTestId("customers-list").waitFor();
    return this;
  }

  async create(): Promise<CustomerNewPage> {
    await this.page.getByTestId("customers-list-create").click();
    return new CustomerNewPage(this.page);
  }

  row(id: string): Locator {
    return this.page.getByTestId(`customers-row-${id}`);
  }

  async open(id: string): Promise<CustomerDetailPage> {
    await this.page.getByTestId(`customers-row-${id}-link`).click();
    await this.page.waitForURL(new RegExp(`/customers/${id}$`));
    return new CustomerDetailPage(this.page, id);
  }

  async expectRow(id: string): Promise<void> {
    await expect(this.row(id)).toBeVisible();
  }
}

export class CustomerNewPage {
  static readonly url = "/customers/new";
  constructor(public readonly page: Page) {}

  async goto(): Promise<this> {
    await this.page.goto(CustomerNewPage.url);
    await this.page.getByTestId("customers-new").waitFor();
    return this;
  }

  async fill(input: Partial<CreateCustomerRequest>): Promise<this> {
    if (input.username !== undefined) {
      await this.page.getByTestId("customers-new-input-username").fill(input.username!);
    }
    if (input.email !== undefined) {
      await this.page.getByTestId("customers-new-input-email").fill(input.email!);
    }
    if (input.age !== undefined) {
      await this.page.getByTestId("customers-new-input-age").fill(String(input.age));
    }
    return this;
  }

  async submit(): Promise<CustomerDetailPage> {
    await this.page.getByTestId("customers-new-submit").click();
    // Wait for the detail page to render rather than matching
    // the URL — `/customers/new` itself matches a naive regex.
    await this.page.getByTestId("customers-detail").waitFor();
    const id = this.page.url().split("/").pop()!;
    return new CustomerDetailPage(this.page, id);
  }
}

export class CustomerDetailPage {
  constructor(public readonly page: Page, public readonly id: string) {}

  async goto(): Promise<this> {
    await this.page.goto(`/customers/${this.id}`);
    await this.page.getByTestId("customers-detail").waitFor();
    return this;
  }

  /** Read a primitive / enum field as displayed text. */
  async field<K extends keyof CustomerResponse>(name: K): Promise<string> {
    return await this.page.getByTestId(`customers-detail-${String(name)}`).innerText();
  }

}
