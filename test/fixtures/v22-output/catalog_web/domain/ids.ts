// Auto-generated.
import { randomUUID } from "node:crypto";

export type CustomerId = string & { readonly __brand: "CustomerId" };
export const CustomerId = (value: string): CustomerId => value as CustomerId;
export const newCustomerId = (): CustomerId => randomUUID() as CustomerId;

