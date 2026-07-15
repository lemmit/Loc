// Auto-generated.  Do not edit by hand.
import type { ProductRepositoryPort } from "../../domain/repository-ports";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema";
import { Product } from "../../domain/product";
import { Money } from "../../domain/value-objects";
import * as Ids from "../../domain/ids";
import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";
import type { DomainEventDispatcher } from "../../domain/events";
import { requestLog } from "../../obs/als";

type Db = NodePgDatabase<typeof schema>;

export class ProductRepository implements ProductRepositoryPort {
  private readonly db: Db;
  private readonly events: DomainEventDispatcher;
  constructor(
    db: Db,
    events: DomainEventDispatcher,
  ) {
    this.db = db;
    this.events = events;
  }

  async findById(id: Ids.ProductId): Promise<Product | null> {
    return await this.db.transaction(async (tx) => {
      const rootRows = await tx.select().from(schema.products).where(eq(schema.products.id, id));
      if (rootRows.length === 0) {
        requestLog().debug({ event: "aggregate_loaded", aggregate: "Product", id: id as string, found: false });
        return null;
      }
      const root = rootRows[0]!;
      const loaded = Product._rehydrate({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency), version: root.version });
      requestLog().debug({ event: "aggregate_loaded", aggregate: "Product", id: id as string, found: true });
      return loaded;
    });
  }

  async getById(id: Ids.ProductId): Promise<Product> {
    const found = await this.findById(id);
    if (!found) throw new AggregateNotFoundError(`Product ${id} not found`);
    return found;
  }

  async findManyByIds(ids: Ids.ProductId[]): Promise<Product[]> {
    if (ids.length === 0) return [];
    const rootRows = await this.db.select().from(schema.products).where(inArray(schema.products.id, ids));
    if (rootRows.length === 0) return [];
    return rootRows.map((root) => Product._rehydrate({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency), version: root.version }));
  }

  async save(aggregate: Product, expectedVersion?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const expected = expectedVersion ?? aggregate.version;
      const existingRow = await tx.select({ id: schema.products.id }).from(schema.products).where(eq(schema.products.id, aggregate.id));
      if (existingRow.length === 0) {
        await tx.insert(schema.products).values({ id: aggregate.id as string, sku: aggregate.sku, price_amount: String(aggregate.price.amount), price_currency: aggregate.price.currency, version: 1 });
      } else {
        const updated = await tx.update(schema.products).set({ id: aggregate.id as string, sku: aggregate.sku, price_amount: String(aggregate.price.amount), price_currency: aggregate.price.currency, version: expected + 1 }).where(and(eq(schema.products.id, aggregate.id), eq(schema.products.version, expected))).returning({ id: schema.products.id });
        if (updated.length === 0) throw new ConcurrencyError("Product", aggregate.id as string);
      }
    });
    requestLog().debug({ event: "repository_save", aggregate: "Product", id: aggregate.id as string });

    for (const event of aggregate.pullEvents()) {
      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "Product", id: aggregate.id as string });
      await this.events.dispatch(event);
    }
  }

  async delete(id: Ids.ProductId): Promise<void> {
    await this.db.delete(schema.products).where(eq(schema.products.id, id));
  }

  async all(page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Product[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const offset = (page - 1) * pageSize;
    const sortColumns: Record<string, AnyPgColumn> = { "id": schema.products.id, "sku": schema.products.sku, "version": schema.products.version };
    const sortColumn = sortColumns[sort] ?? schema.products.id;
    const orderBy = dir === "desc" ? desc(sortColumn) : asc(sortColumn);
    const countRows = await this.db.select({ value: count() }).from(schema.products);
    const total = Number(countRows[0]?.value ?? 0);
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const rootRows = await this.db.select().from(schema.products).orderBy(orderBy).limit(pageSize).offset(offset);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Product", find: "all", rows: 0 });
      return { items: [], page, pageSize, total, totalPages };
    }
    const items = rootRows.map((root) => Product._rehydrate({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency), version: root.version }));
    requestLog().debug({ event: "find_executed", aggregate: "Product", find: "all", rows: items.length });
    return { items, page, pageSize, total, totalPages };
  }

  async bySku(sku: string): Promise<Product | null> {
    const rootRows = await this.db.select().from(schema.products).where(eq(schema.products.sku, sku)).limit(1);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Product", find: "bySku", rows: 0 });
      return null;
    }
    const result = Product._rehydrate({ id: Ids.ProductId(rootRows[0]!.id), sku: rootRows[0]!.sku, price: new Money(Number(rootRows[0]!.price_amount), rootRows[0]!.price_currency), version: rootRows[0]!.version });
    requestLog().debug({ event: "find_executed", aggregate: "Product", find: "bySku", rows: 1 });
    return result;
  }

  toWire(root: Product): unknown {
    return { id: root.id as string, sku: root.sku, price: { amount: root.price.amount, currency: root.price.currency }, version: root.version, display: root.display };
  }

}
