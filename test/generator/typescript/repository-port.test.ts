// Repository PORTS (hexagonal architecture — audit S7).  The generated domain
// layer must depend on a domain-owned repository PORT, not the concrete infra
// repository.  These pins assert: the pooled `domain/repository-ports.ts` is
// emitted, the concrete `<Agg>Repository` `implements` its port, the port is
// ORM-neutral (no Drizzle vocabulary), and presentation (`toWire`) is excluded.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
  system S {
    subdomain D { context C {
      aggregate Order with crudish { total: int }
      repository OrderRepo for Order {
        find byMin(m: int): Order[] where this.total > m
      }
    }}
    storage primary { type: postgres }
    resource cState { for: C, kind: state, use: primary }
    deployable web { platform: node  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

let cache: Map<string, string> | undefined;
async function files(): Promise<Map<string, string>> {
  cache ??= await generateSystemFiles(SRC);
  return cache;
}

function get(map: Map<string, string>, suffix: string): string {
  const k = [...map.keys()].find((key) => key.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return map.get(k!)!;
}

describe("repository ports (audit S7)", () => {
  it("emits a pooled domain/repository-ports.ts with a per-aggregate interface", async () => {
    const port = get(await files(), "domain/repository-ports.ts");
    expect(port).toBeDefined();
    expect(port).toContain("export interface OrderRepositoryPort {");
    // The full domain-facing surface (CRUD + each find), in domain terms.
    expect(port).toContain("findById(id: Ids.OrderId): Promise<Order | null>;");
    expect(port).toContain("getById(id: Ids.OrderId): Promise<Order>;");
    expect(port).toContain("findManyByIds(ids: Ids.OrderId[]): Promise<Order[]>;");
    expect(port).toContain("save(aggregate: Order, expectedVersion?: number): Promise<void>;");
    expect(port).toContain("delete(id: Ids.OrderId): Promise<void>;");
    expect(port).toContain("byMin(m: number): Promise<Order[]>;");
  });

  it("the port is ORM-neutral (no Drizzle vocabulary) and excludes presentation (toWire)", async () => {
    const port = get(await files(), "domain/repository-ports.ts");
    expect(port).not.toContain("drizzle");
    expect(port).not.toContain("NodePgDatabase");
    expect(port).not.toContain("schema");
    expect(port).not.toContain("toWire");
  });

  it("the concrete repository implements its port (compile-proven adapter)", async () => {
    const repo = get(await files(), "db/repositories/order-repository.ts");
    expect(repo).toContain("export class OrderRepository implements OrderRepositoryPort {");
    expect(repo).toContain(
      'import type { OrderRepositoryPort } from "../../domain/repository-ports";',
    );
  });
});
