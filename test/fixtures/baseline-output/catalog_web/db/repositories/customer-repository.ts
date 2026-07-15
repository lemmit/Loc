// Auto-generated.  Do not edit by hand.
import type { CustomerRepositoryPort } from "../../domain/repository-ports";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import * as schema from "../schema";
import { Customer } from "../../domain/customer";
import * as Ids from "../../domain/ids";
import { AggregateNotFoundError, ConcurrencyError } from "../../domain/errors";
import type { DomainEventDispatcher } from "../../domain/events";
import { requestLog } from "../../obs/als";

type Db = NodePgDatabase<typeof schema>;

export class CustomerRepository implements CustomerRepositoryPort {
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
      const loaded = Customer._rehydrate({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age, version: root.version });
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
    return rootRows.map((root) => Customer._rehydrate({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age, version: root.version }));
  }

  async save(aggregate: Customer, expectedVersion?: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      const expected = expectedVersion ?? aggregate.version;
      const existingRow = await tx.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, aggregate.id));
      if (existingRow.length === 0) {
        await tx.insert(schema.customers).values({ id: aggregate.id as string, username: aggregate.username, email: aggregate.email, age: aggregate.age, version: 1 });
      } else {
        const updated = await tx.update(schema.customers).set({ id: aggregate.id as string, username: aggregate.username, email: aggregate.email, age: aggregate.age, version: expected + 1 }).where(and(eq(schema.customers.id, aggregate.id), eq(schema.customers.version, expected))).returning({ id: schema.customers.id });
        if (updated.length === 0) throw new ConcurrencyError("Customer", aggregate.id as string);
      }
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

  async all(page: number, pageSize: number, sort: string, dir: string): Promise<{ items: Customer[]; page: number; pageSize: number; total: number; totalPages: number }> {
    const offset = (page - 1) * pageSize;
    const sortColumns: Record<string, AnyPgColumn> = { "id": schema.customers.id, "username": schema.customers.username, "email": schema.customers.email, "age": schema.customers.age };
    const sortColumn = sortColumns[sort] ?? schema.customers.id;
    const orderBy = dir === "desc" ? desc(sortColumn) : asc(sortColumn);
    const countRows = await this.db.select({ value: count() }).from(schema.customers);
    const total = Number(countRows[0]?.value ?? 0);
    const totalPages = pageSize > 0 ? Math.ceil(total / pageSize) : 0;
    const rootRows = await this.db.select().from(schema.customers).orderBy(orderBy).limit(pageSize).offset(offset);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "all", rows: 0 });
      return { items: [], page, pageSize, total, totalPages };
    }
    const items = rootRows.map((root) => Customer._rehydrate({ id: Ids.CustomerId(root.id), username: root.username, email: root.email, age: root.age, version: root.version }));
    requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "all", rows: items.length });
    return { items, page, pageSize, total, totalPages };
  }

  async byEmail(email: string): Promise<Customer | null> {
    const rootRows = await this.db.select().from(schema.customers).where(eq(schema.customers.email, email)).limit(1);
    if (rootRows.length === 0) {
      requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "byEmail", rows: 0 });
      return null;
    }
    const result = Customer._rehydrate({ id: Ids.CustomerId(rootRows[0]!.id), username: rootRows[0]!.username, email: rootRows[0]!.email, age: rootRows[0]!.age, version: rootRows[0]!.version });
    requestLog().debug({ event: "find_executed", aggregate: "Customer", find: "byEmail", rows: 1 });
    return result;
  }

  toWire(root: Customer): unknown {
    return { id: root.id as string, username: root.username, email: root.email, age: root.age, version: root.version, display: root.display };
  }

}
