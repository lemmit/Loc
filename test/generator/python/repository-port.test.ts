// Repository PORTS (hexagonal architecture — audit S7).  Python: a pooled
// `app/domain/repository_ports.py` declares a `Protocol` per aggregate; the
// domain services depend on it instead of the concrete `app.db.repositories`
// class.  Protocols are structural, so the concrete needs no explicit
// inheritance — `mypy --strict` proves conformance at the workflow call site.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

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
    deployable api { platform: python  contexts: [C]  dataSources: [cState]  port: 3000 }
  }
`;

async function files(): Promise<Map<string, string>> {
  return (await generateSystems(await parseValid(SRC))).files;
}

function get(map: Map<string, string>, suffix: string): string {
  const k = [...map.keys()].find((key) => key.endsWith(suffix));
  expect(k, `${suffix} not emitted`).toBeDefined();
  return map.get(k!)!;
}

describe("python repository ports (audit S7)", () => {
  it("emits a pooled app/domain/repository_ports.py with a per-aggregate Protocol", async () => {
    const port = get(await files(), "app/domain/repository_ports.py");
    expect(port).toContain("from typing import Protocol");
    expect(port).toContain("class OrderRepositoryPort(Protocol):");
    expect(port).toContain("async def find_by_id(self, id: OrderId) -> Order | None: ...");
    expect(port).toContain("async def get_by_id(self, id: OrderId) -> Order: ...");
    expect(port).toContain(
      "async def save(self, aggregate: Order, expected_version: int | None = None) -> None: ...",
    );
    expect(port).toContain("async def delete(self, id: OrderId) -> None: ...");
    expect(port).toContain("async def by_min(self, m: int) -> list[Order]: ...");
  });

  it("the Protocol is ORM-neutral (no SQLAlchemy) and excludes presentation (to_wire) + helpers", async () => {
    const port = get(await files(), "app/domain/repository_ports.py");
    expect(port).not.toContain("sqlalchemy");
    expect(port).not.toContain("AsyncSession");
    expect(port).not.toContain("app.db");
    expect(port).not.toContain("to_wire");
    expect(port).not.toContain("_hydrate");
  });
});
