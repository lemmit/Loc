// Auto-generated.  Do not edit by hand.
import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import type { CreateProductRequest, ProductResponse } from "../../src/api/product";

export class ProductListPage {
  static readonly url = "/products";
  constructor(public readonly page: Page) {}

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
  constructor(public readonly page: Page) {}

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
  constructor(public readonly page: Page, public readonly id: string) {}

  async goto(): Promise<this> {
    await this.page.goto(`/products/${this.id}`);
    await this.page.getByTestId("products-detail").waitFor();
    return this;
  }

  /** Read a primitive / enum field as displayed text. */
  async field<K extends keyof ProductResponse>(name: K): Promise<string> {
    return await this.page.getByTestId(`products-detail-${String(name)}`).innerText();
  }

}
