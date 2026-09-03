import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// G2667-D3, elixir arm — a query-time projection's `join` indexed the batched
// id→row map UNGUARDED:
//
//   customerName: Map.get(customer_by_id, record.customer_id).name
//
// The map holds only what the follow-up read RETURNED, so a join target that is
// soft-deleted (or filtered out by a capability) is ABSENT — and `nil.name`
// raises `UndefinedFunctionError` at request time.  Ordinary data therefore
// answered 500.
//
// Decision, matching the .NET / node arms: LEFT-JOIN semantics — the source row
// survives, the joined field is nil.  Emitted as a total `__joined/2` reader,
// which is also emitted ONLY when called (an unused private function fails
// `mix compile --warnings-as-errors`).
// ---------------------------------------------------------------------------

const JOIN_SRC = `
system ProjectionJoinSys {
  subdomain Sales {
    context Orders {
      aggregate Customer with crudish {
        name: string
        tier: string
      }
      aggregate Order with crudish {
        code: string
        total: money
        customerId: Customer id
        derived display: string = code
      }
      repository Orders for Order { }
      repository Customers for Customer { }
      projection OrderWithCustomer {
        orderId: Order id
        code: string
        total: money
        customerName: string
        customerTier: string
        from Order as o
        join Customer as c on o.customerId
        select orderId = o.id,
               code = o.code,
               total = o.total,
               customerName = c.name,
               customerTier = c.tier
      }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable d {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

// A join-LESS query-time projection: the `__joined/2` helper must NOT be
// emitted here, or every such module fails --warnings-as-errors on an unused
// private function.
const NO_JOIN_SRC = `
system PlainProjSys {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        code: string
        total: money
        derived display: string = code
      }
      repository Orders for Order { }
      projection OrderCodes {
        orderId: Order id
        code: string
        from Order as o
        select orderId = o.id, code = o.code
      }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  deployable d {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

async function projectionModule(src: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(src);
  for (const [p, c] of files) {
    if (p.endsWith(suffix)) return c;
  }
  throw new Error(`${suffix} not emitted (have: ${[...files.keys()].join(", ")})`);
}

describe("query-time projection join — an absent target left-joins, it does not raise", () => {
  it("reads the joined field through the total `__joined/2`, never off a bare Map.get", async () => {
    const mod = await projectionModule(JOIN_SRC, "query_projections/order_with_customer.ex");
    expect(mod).toContain("__joined(Map.get(customer_by_id, record.customer_id), :name)");
    expect(mod).toContain("__joined(Map.get(customer_by_id, record.customer_id), :tier)");
    // The raising shape — `Map.get(map, id).field` — must be gone entirely.
    expect(mod).not.toMatch(/Map\.get\([a-z_]+, [^)]*\)\.[a-z_]/);
  });

  it("emits the `__joined/2` clauses, nil-total on the head", async () => {
    const mod = await projectionModule(JOIN_SRC, "query_projections/order_with_customer.ex");
    expect(mod).toContain("defp __joined(nil, _field), do: nil");
    expect(mod).toContain("defp __joined(record, field), do: Map.get(record, field)");
  });

  it("omits `__joined/2` from a join-less projection (unused defp = a failed build)", async () => {
    const mod = await projectionModule(NO_JOIN_SRC, "query_projections/order_codes.ex");
    expect(mod).not.toContain("__joined");
  });
});
