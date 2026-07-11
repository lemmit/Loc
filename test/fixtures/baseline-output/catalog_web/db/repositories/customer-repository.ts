// Auto-generated.  Do not edit by hand.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq, inArray } from "drizzle-orm";
import * as schema from "../schema";
import { Customer } from "../../domain/customer";
import * as Ids from "../../domain/ids";
import { AggregateNotFoundError } from "../../domain/errors";
import type { DomainEventDispatcher } from "../../domain/events";
import { requestLog } from "../../obs/als";

type Db = NodePgDatabase<typeof schema>;

export class CustomerRepository {
  private readonly db: Db;
  private readonly events: DomainEventDispatcher;
  constructor(
    db: Db,
    events: DomainEventDispatcher,
  ) {
    this.db = db;
    this.events = events;
  }

  async findById(id: Ids.CustomerId): Promise<Customer | null> {
    return await this.db.transaction(async (tx) => {
      const rootRows = await tx.select().from(schema.customers).where(eq(schema.customers.id, id));
      if (rootRows.length === 0) {
        requestLog().debug({ event: "aggregate_loaded", aggregate: "Customer", id: id as string, found: false });
        return null;
      }
      const root = rootRows[0]!;
      const loaded = Customer._rehydrate({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age });
      requestLog().debug({ event: "aggregate_loaded", aggregate: "Customer", id: id as string, found: true });
      return loaded;
    });
  }

  async getById(id: Ids.CustomerId): Promise<Customer> {
    const found = await this.findById(id);
    if (!found) throw new AggregateNotFoundError(`Customer ${id} not found`);
    return found;
  }

  async findManyByIds(ids: Ids.CustomerId[]): Promise<Customer[]> {
    if (ids.length === 0) return [];
    const rootRows = await this.db.select().from(schema.customers).where(inArray(schema.customers.id, ids));
    if (rootRows.length === 0) return [];
    return rootRows.map((root) => Customer._rehydrate({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age }));
  }

  async save(aggregate: Customer): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rootRow = { id: aggregate.id as string, username: aggregate.username, email: aggregate.email, age: aggregate.age };
      await tx.insert(schema.customers).values(rootRow).onConflictDoUpdate({ target: schema.customers.id, set: rootRow });
    });
    requestLog().debug({ event: "repository_save", aggregate: "Customer", id: aggregate.id as string });

    for (const event of aggregate.pullEvents()) {
      requestLog().info({ event: "event_dispatched", event_type: (event as object).constructor.name, aggregate: "Customer", id: aggregate.id as string });
      await this.events.dispatch(event);
    }
  }

  async delete(id: Ids.CustomerId): Promise<void> {
    await this.db.delete(schema.customers).where(eq(schema.customers.id, id));
  }

  async all(): Promise<Customer[]> {
    const rootRows = await this.db.select().from(schema.customers);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "all", rows: 0 });
      return [];
    }
    const result = rootRows.map((root) => Customer._rehydrate({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age }));
    requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "all", rows: result.length });
    return result;
  }

  async byEmail(email: string): Promise<Customer | null> {
    const rootRows = await this.db.select().from(schema.customers).where(eq(schema.customers.email, email)).limit(1);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "byEmail", rows: 0 });
      return null;
    }
    const result = Customer._rehydrate({ id: Ids.CustomerId(rootRows[0]!.id), username: rootRows[0]!.username, email: rootRows[0]!.email, age: rootRows[0]!.age });
    requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "byEmail", rows: 1 });
    return result;
  }

  toWire(root: Customer): unknown {
    return { id: root.id as string, username: root.username, email: root.email, age: root.age, display: root.display };
  }

}
