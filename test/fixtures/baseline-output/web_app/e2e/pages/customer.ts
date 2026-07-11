// Auto-generated.  Do not edit by hand.
import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { CreateCustomerRequest, UpdateCustomerRequest, CustomerResponse } from "../../src/api/customer";

export class CustomerListPage {
  static readonly url = "/customers";
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

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
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

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
  readonly page: Page;
  readonly id: string;
  constructor(page: Page, id: string) {
    this.page = page;
    this.id = id;
  }

  async goto(): Promise<this> {
    await this.page.goto(`/customers/${this.id}`);
    await this.page.getByTestId("customers-detail").waitFor();
    return this;
  }

  /** Locator for a primitive / enum field's value cell. */
  field<K extends keyof CustomerResponse>(name: K): Locator {
    return this.page.getByTestId(`customers-detail-${String(name)}`);
  }

  /** update — opens the modal, fills the form, submits. */
  async update(input: UpdateCustomerRequest): Promise<this> {
    await this.page.getByTestId("customers-op-update").click();
    await this.page.getByTestId("customers-op-update-form").waitFor();
    if (input.username !== undefined) {
      await this.page.getByTestId("customers-op-update-input-username").fill(input.username!);
    }
    if (input.email !== undefined) {
      await this.page.getByTestId("customers-op-update-input-email").fill(input.email!);
    }
    if (input.age !== undefined) {
      await this.page.getByTestId("customers-op-update-input-age").fill(String(input.age));
    }
    await this.page.getByTestId("customers-op-update-submit").click();
    await this.page.getByTestId("customers-op-update-form").waitFor({ state: "detached" });
    await this.page.waitForLoadState("networkidle");
    return this;
  }

}
