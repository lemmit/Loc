// Auto-generated.  Do not edit by hand.
// Domain-owned repository ports (hexagonal architecture — audit S7).
import type * as Ids from "./ids";
import type { Customer } from "./customer";
import type { Product } from "./product";

export interface ProductRepositoryPort {
  findById(id: Ids.ProductId): Promise<Product | null>;
  getById(id: Ids.ProductId): Promise<Product>;
  findManyByIds(ids: Ids.ProductId[]): Promise<Product[]>;
  save(aggregate: Product, expectedVersion?: number): Promise<void>;
  delete(id: Ids.ProductId): Promise<void>;
  all(page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Product[]; page: number; pageSize: number; total: number; totalPages: number }>;
  bySku(sku: string): Promise<Product | null>;
}

export interface CustomerRepositoryPort {
  findById(id: Ids.CustomerId): Promise<Customer | null>;
  getById(id: Ids.CustomerId): Promise<Customer>;
  findManyByIds(ids: Ids.CustomerId[]): Promise<Customer[]>;
  save(aggregate: Customer, expectedVersion?: number): Promise<void>;
  delete(id: Ids.CustomerId): Promise<void>;
  all(page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Customer[]; page: number; pageSize: number; total: number; totalPages: number }>;
  byEmail(email: string): Promise<Customer | null>;
}
