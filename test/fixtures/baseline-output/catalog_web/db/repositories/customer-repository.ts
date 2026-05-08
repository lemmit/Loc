// Auto-generated.  Do not edit by hand.
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import * as schema from "../schema";
import { Customer } from "../../domain/customer";
import * as Ids from "../../domain/ids";
import { AggregateNotFoundError } from "../../domain/errors";
import type { DomainEventDispatcher } from "../../domain/events";

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class CustomerRepository {
  constructor(
    private readonly db: Db,
    private readonly events: DomainEventDispatcher,
  ) {}

  async findById(id: Ids.CustomerId): Promise<Customer | null> {
    return await this.db.transaction(async (tx) => {
      const rootRows = await tx.select().from(schema.customers).where(eq(schema.customers.id, id));
      if (rootRows.length === 0) return null;
      const root = rootRows[0]!;
      return Customer._create({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age });
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
    return rootRows.map((root) => Customer._create({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age }));
  }

  async save(aggregate: Customer): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rootRow = { id: aggregate.id as string, username: aggregate.username, email: aggregate.email, age: aggregate.age };
      await tx.insert(schema.customers).values(rootRow).onConflictDoUpdate({ target: schema.customers.id, set: rootRow });
    });

    for (const event of aggregate.pullEvents()) {
      await this.events.dispatch(event);
    }
  }

  async all(): Promise<Customer[]> {
    const rootRows = await this.db.select().from(schema.customers);
    if (rootRows.length === 0) return [];
    return rootRows.map((root) => Customer._create({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age }));
  }

  async byEmail(email: string): Promise<Customer | null> {
    const rootRows = await this.db.select().from(schema.customers).where(eq(schema.customers.email, email)).limit(1);
    if (rootRows.length === 0) return null;
    return await this.findById(rootRows[0]!.id as Ids.CustomerId) as Customer | null;
  }

  toWire(root: Customer): unknown {
    return { id: root.id as string, username: root.username, email: root.email, age: root.age };
  }

}
