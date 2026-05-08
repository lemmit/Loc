// Auto-generated.
import { randomUUID } from "node:crypto";

export type ProductId = string & { readonly __brand: "ProductId" };
export const ProductId = (value: string): ProductId => value as ProductId;
export const newProductId = (): ProductId => randomUUID() as ProductId;

export type CustomerId = string & { readonly __brand: "CustomerId" };
export const CustomerId = (value: string): CustomerId => value as CustomerId;
export const newCustomerId = (): CustomerId => randomUUID() as CustomerId;

