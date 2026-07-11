// Auto-generated.  Do not edit by hand.
import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { CreateProductRequest, UpdateProductRequest, ProductResponse } from "../../src/api/product";

export class ProductListPage {
  static readonly url = "/products";
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<this> {
    await this.page.goto(ProductListPage.url);
    await this.page.getByTestId("products-list").waitFor();
    return this;
  }

  async create(): Promise<ProductNewPage> {
    await this.page.getByTestId("products-list-create").click();
    return new ProductNewPage(this.page);
  }

  row(id: string): Locator {
    return this.page.getByTestId(`products-row-${id}`);
  }

  async open(id: string): Promise<ProductDetailPage> {
    await this.page.getByTestId(`products-row-${id}-link`).click();
    await this.page.waitForURL(new RegExp(`/products/${id}$`));
    return new ProductDetailPage(this.page, id);
  }

  async expectRow(id: string): Promise<void> {
    await expect(this.row(id)).toBeVisible();
  }
}

export class ProductNewPage {
  static readonly url = "/products/new";
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }

  async goto(): Promise<this> {
    await this.page.goto(ProductNewPage.url);
    await this.page.getByTestId("products-new").waitFor();
    return this;
  }

  async fill(input: Partial<CreateProductRequest>): Promise<this> {
    if (input.sku !== undefined) {
      await this.page.getByTestId("products-new-input-sku").fill(input.sku!);
    }
    if (input.price !== undefined) {
      if (input.price!.amount !== undefined) {
        await this.page.getByTestId("products-new-input-price-amount").fill(String(input.price!.amount));
      }
      if (input.price!.currency !== undefined) {
        await this.page.getByTestId("products-new-input-price-currency").fill(input.price!.currency!);
      }
    }
    return this;
  }

  async submit(): Promise<ProductDetailPage> {
    await this.page.getByTestId("products-new-submit").click();
    // Wait for the detail page to render rather than matching
    // the URL — `/products/new` itself matches a naive regex.
    await this.page.getByTestId("products-detail").waitFor();
    const id = this.page.url().split("/").pop()!;
    return new ProductDetailPage(this.page, id);
  }
}

export class ProductDetailPage {
  readonly page: Page;
  readonly id: string;
  constructor(page: Page, id: string) {
    this.page = page;
    this.id = id;
  }

  async goto(): Promise<this> {
    await this.page.goto(`/products/${this.id}`);
    await this.page.getByTestId("products-detail").waitFor();
    return this;
  }

  /** Locator for a primitive / enum field's value cell. */
  field<K extends keyof ProductResponse>(name: K): Locator {
    return this.page.getByTestId(`products-detail-${String(name)}`);
  }

  /** update — opens the modal, fills the form, submits. */
  async update(input: UpdateProductRequest): Promise<this> {
    await this.page.getByTestId("products-op-update").click();
    await this.page.getByTestId("products-op-update-form").waitFor();
    if (input.sku !== undefined) {
      await this.page.getByTestId("products-op-update-input-sku").fill(input.sku!);
    }
    if (input.price !== undefined) {
      if (input.price!.amount !== undefined) {
        await this.page.getByTestId("products-op-update-input-price-amount").fill(String(input.price!.amount));
      }
      if (input.price!.currency !== undefined) {
        await this.page.getByTestId("products-op-update-input-price-currency").fill(input.price!.currency!);
      }
    }
    await this.page.getByTestId("products-op-update-submit").click();
    await this.page.getByTestId("products-op-update-form").waitFor({ state: "detached" });
    await this.page.waitForLoadState("networkidle");
    return this;
  }

}
