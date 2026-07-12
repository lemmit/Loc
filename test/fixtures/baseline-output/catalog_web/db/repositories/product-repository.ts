// Auto-generated.  Do not edit by hand.
import type { ProductRepositoryPort } from "../../domain/repository-ports";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../schema";
import { Product } from "../../domain/product";
import { Money } from "../../domain/value-objects";
import * as Ids from "../../domain/ids";
import { AggregateNotFoundError } from "../../domain/errors";
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
      const loaded = Product._rehydrate({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency) });
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
    return rootRows.map((root) => Product._rehydrate({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency) }));
  }

  async save(aggregate: Product): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rootRow = { id: aggregate.id as string, sku: aggregate.sku, price_amount: String(aggregate.price.amount), price_currency: aggregate.price.currency };
      await tx.insert(schema.products).values(rootRow).onConflictDoUpdate({ target: schema.products.id, set: rootRow });
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

  async all(): Promise<Product[]> {
    const rootRows = await this.db.select().from(schema.products);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Product", find: "all", rows: 0 });
      return [];
    }
    const result = rootRows.map((root) => Product._rehydrate({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency) }));
    requestLog().debug({ event: "find_executed", aggregate: "Product", find: "all", rows: result.length });
    return result;
  }

  async bySku(sku: string): Promise<Product | null> {
    const rootRows = await this.db.select().from(schema.products).where(eq(schema.products.sku, sku)).limit(1);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Product", find: "bySku", rows: 0 });
      return null;
    }
    const result = Product._rehydrate({ id: Ids.ProductId(rootRows[0]!.id), sku: rootRows[0]!.sku, price: new Money(Number(rootRows[0]!.price_amount), rootRows[0]!.price_currency) });
    requestLog().debug({ event: "find_executed", aggregate: "Product", find: "bySku", rows: 1 });
    return result;
  }

  toWire(root: Product): unknown {
    return { id: root.id as string, sku: root.sku, price: { amount: root.price.amount, currency: root.price.currency }, display: root.display };
  }

}
