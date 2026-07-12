// Auto-generated.
import { uuidv7 } from "uuidv7";

export type ProductId = string & { readonly __brand: "ProductId" };
export const ProductId = (value: string): ProductId => value as ProductId;
export const newProductId = (): ProductId => uuidv7() as ProductId;

export type CustomerId = string & { readonly __brand: "CustomerId" };
export const CustomerId = (value: string): CustomerId => value as CustomerId;
export const newCustomerId = (): CustomerId => uuidv7() as CustomerId;

