// Auto-generated.  Do not edit by hand.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../schema.js";
import { Product } from "../../domain/product.js";
import { Money } from "../../domain/value-objects.js";
import * as Ids from "../../domain/ids.js";
import { AggregateNotFoundError } from "../../domain/errors.js";
import type { DomainEventDispatcher } from "../../domain/events.js";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class ProductRepository {
  constructor(
    private readonly db: Db,
    private readonly events: DomainEventDispatcher,
  ) {}

  async findById(id: Ids.ProductId): Promise<Product | null> {
    return await this.db.transaction(async (tx) => {
      const rootRows = await tx.select().from(schema.products).where(eq(schema.products.id, id));
      if (rootRows.length === 0) return null;
      const root = rootRows[0]!;
      return Product._create({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency) });
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
    return rootRows.map((root) => Product._create({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency) }));
  }

  async save(aggregate: Product): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rootRow = { id: aggregate.id as string, sku: aggregate.sku, price_amount: String(aggregate.price.amount), price_currency: aggregate.price.currency };
      await tx.insert(schema.products).values(rootRow).onConflictDoUpdate({ target: schema.products.id, set: rootRow });
    });

    for (const event of aggregate.pullEvents()) {
      await this.events.dispatch(event);
    }
  }

  async all(): Promise<Product[]> {
    const rootRows = await this.db.select().from(schema.products);
    if (rootRows.length === 0) return [];
    return rootRows.map((root) => Product._create({ id: Ids.ProductId(root.id), sku: root.sku, price: new Money(Number(root.price_amount), root.price_currency) }));
  }

  async bySku(sku: string): Promise<Product | null> {
    const rootRows = await this.db.select().from(schema.products).where(eq(schema.products.sku, sku)).limit(1);
    if (rootRows.length === 0) return null;
    return await this.findById(rootRows[0]!.id as Ids.ProductId) as Product | null;
  }

  toWire(root: Product): unknown {
    return { id: root.id as string, sku: root.sku, price: { amount: root.price.amount, currency: root.price.currency } };
  }

}
