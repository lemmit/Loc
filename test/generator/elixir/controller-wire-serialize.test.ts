// The DEPLOYABLE-LEVEL vanilla controllers — `WorkflowsController` (one per
// deployable, over every hosted context's command workflows) and each
// `<Api>RoutesController` (explicit `route … -> <Ctx>.<Handler>` bindings) —
// hand an aggregate result to Jason.  Both used to dump the raw Ecto struct
// (`Map.from_struct |> Map.drop([:__meta__, :__struct__])`), so a workflow /
// handler that returned a saved aggregate shipped snake_case keys plus Ecto's
// `inserted_at` / `updated_at` — a DIFFERENT body from the `GET /<aggs>/{id}`
// for the same row, on the same backend, while node/.NET/Java/Python all
// project `wireShape`.
//
// Both now dispatch per-aggregate through `renderWireSerialize`
// (`controller-serialize.ts`), with the raw-struct `%_{}` clause kept BEHIND
// the struct-typed heads for a non-aggregate struct.
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const WORKFLOW_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        commitSha: string
        buildState: string
        operation confirm() { buildState := "confirmed" }
      }
      repository Orders for Order { }
      workflow placeOrder {
        create(sha: string) {
          let o = Order.create({ commitSha: sha, buildState: "new" })
        }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

const HANDLER_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order {
        commitSha: string
        buildState: string
        operation cancel() { buildState := "cancelled" }
      }
      repository Orders for Order { }
      commandHandler CancelOrder(orderId: Order id): Order {
        let o = Orders.getById(orderId)
        o.cancel()
        return o
      }
    }
  }
  api SalesApi from Sales {
    route POST "/orders/{orderId}/cancellations" -> Ordering.CancelOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

/** Route A (`shape: document`) — the wire fields live on the `:data` embed while
 *  `id` / `version` stay on the root row, so the serializer has to be rooted the
 *  way `api-emit` roots the aggregate's own controller. */
const DOCUMENT_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      aggregate Order shape: document {
        commitSha: string
        buildState: string
      }
      repository Orders for Order { }
      workflow placeOrder {
        create(sha: string) {
          let o = Order.create({ commitSha: sha, buildState: "new" })
        }
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

async function fileEndingWith(src: string, suffix: string): Promise<string> {
  const files = await generateSystemFiles(src);
  const hit = [...files.entries()].find(([k]) => k.endsWith(suffix));
  expect(hit, `${suffix} not emitted`).toBeDefined();
  return hit![1];
}

describe("vanilla WorkflowsController serialize", () => {
  it("dispatches an aggregate result through its wireShape serializer", async () => {
    const c = await fileEndingWith(WORKFLOW_SRC, "controllers/workflows_controller.ex");
    // The struct-typed dispatch clause, ahead of the raw-struct catch-all.
    expect(c).toContain(
      "defp serialize(%Api.Ordering.Order{} = record), do: serialize_ordering_order(record)",
    );
    // camelCase wire keys, exactly as `wireShape` names them — NOT the
    // snake_case Ecto columns the raw dump shipped.
    expect(c).toContain('"commitSha" => record.commit_sha');
    expect(c).toContain('"buildState" => record.build_state');
    // Ecto's auto-timestamps are not wire fields on any backend.
    expect(c).not.toContain("inserted_at");
    expect(c).not.toContain("updated_at");
    // Clause ORDER is load-bearing: `%_{}` matches ANY struct, so it must sit
    // behind every aggregate head; the pass-through tail stays.
    const dispatchAt = c.indexOf("defp serialize(%Api.Ordering.Order{}");
    const catchAllAt = c.indexOf("defp serialize(%_{} = struct)");
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(catchAllAt).toBeGreaterThan(dispatchAt);
    expect(c).toContain("defp serialize(other), do: other");
  });

  it("roots a `shape: document` aggregate at its `:data` embed", async () => {
    const c = await fileEndingWith(DOCUMENT_SRC, "controllers/workflows_controller.ex");
    expect(c).toContain("defp serialize_ordering_order(row) do");
    expect(c).toContain("record = row.data");
    // `id` / `version` live on the ROOT row, the rest on the embed.
    expect(c).toContain('"id" => row.id');
    expect(c).toContain('"version" => row.version');
    expect(c).toContain('"commitSha" => record.commit_sha');
  });
});

describe("vanilla <Api>RoutesController serialize", () => {
  it("dispatches an aggregate result through its wireShape serializer", async () => {
    const c = await fileEndingWith(HANDLER_SRC, "controllers/sales_api_routes_controller.ex");
    expect(c).toContain(
      "defp serialize(%Api.Ordering.Order{} = record), do: serialize_ordering_order(record)",
    );
    expect(c).toContain('"commitSha" => record.commit_sha');
    expect(c).toContain('"buildState" => record.build_state');
    expect(c).not.toContain("inserted_at");
    expect(c).not.toContain("updated_at");
    // The list arm must stay FIRST — it is the collection projection, and a
    // list is what a find handler returns.
    const listAt = c.indexOf("defp serialize(list) when is_list(list)");
    const dispatchAt = c.indexOf("defp serialize(%Api.Ordering.Order{}");
    const catchAllAt = c.indexOf("defp serialize(%_{} = struct)");
    expect(listAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(listAt);
    expect(catchAllAt).toBeGreaterThan(dispatchAt);
    expect(c).toContain("defp serialize(other), do: other");
  });
});

// ---------------------------------------------------------------------------
// NON-AGGREGATE handler results.
//
// A `commandHandler` / `queryHandler` may `return` a bare scalar or a value
// object, and that value lands on this same `serialize/1`.  The `%_{} = struct`
// fallback dumps ANY struct, which is not a projection for the two struct-shaped
// scalars Ecto hands back:
//
//   * `%DateTime{}` → `Map.from_struct` yields the calendar internals including
//     the `microsecond: {0, 6}` TUPLE, which Jason cannot encode — the route
//     500s.  Untouched it encodes ISO-8601, what the aggregate read path
//     (`"placedAt" => record.placed_at`) and the other four backends send.
//   * `%Decimal{}` → `Map.from_struct` yields `%{coef:, exp:, sign:}` where
//     every other backend sends the number (RS-24) / fixed-scale string (RS-12).
//
// A bare VALUE OBJECT is not a struct at all on this backend (VOs are
// schemaless jsonb maps), so it fell past `%_{}` to `serialize(other), do:
// other` and shipped its STORED keys — `currency_code` where the aggregate
// read, and every other backend, ship `currencyCode`.
// ---------------------------------------------------------------------------
const SCALAR_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      valueobject Money { amount: decimal  currencyCode: string }
      aggregate Order {
        code: string
        total: Money
        placedAt: datetime
        operation cancel() { code := "x" }
      }
      repository Orders for Order { }
      queryHandler GetTotal(orderId: Order id): Money {
        let o = Orders.getById(orderId)
        return o.total
      }
      queryHandler GetPlacedAt(orderId: Order id): datetime {
        let o = Orders.getById(orderId)
        return o.placedAt
      }
      queryHandler GetAmount(orderId: Order id): decimal {
        let o = Orders.getById(orderId)
        return o.total.amount
      }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/{orderId}/total" -> Ordering.GetTotal
    route GET "/orders/{orderId}/placed" -> Ordering.GetPlacedAt
    route GET "/orders/{orderId}/amount" -> Ordering.GetAmount
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

// The same aggregate + routes, but every declared result is an aggregate — the
// gate must leave such a system byte-identical (no scalar / VO clauses).
const NO_SCALAR_SRC = `
system Shop {
  subdomain Sales {
    context Ordering {
      valueobject Money { amount: decimal  currencyCode: string }
      aggregate Order {
        code: string
        total: Money
        placedAt: datetime
        operation cancel() { code := "x" }
      }
      repository Orders for Order { }
      queryHandler GetOrder(orderId: Order id): Order {
        let o = Orders.getById(orderId)
        return o
      }
    }
  }
  api SalesApi from Sales {
    route GET "/orders/{orderId}" -> Ordering.GetOrder
  }
  storage pg { type: postgres }
  resource st { for: Ordering, kind: state, use: pg }
  deployable api { platform: elixir, contexts: [Ordering], dataSources: [st], serves: SalesApi, port: 5001 }
}
`;

describe("vanilla <Api>RoutesController serialize — non-aggregate declared results", () => {
  it("hands a bare temporal result to Jason instead of exploding its calendar internals", async () => {
    const c = await fileEndingWith(SCALAR_SRC, "controllers/sales_api_routes_controller.ex");
    expect(c).toContain("defp serialize(%DateTime{} = value), do: value");
    expect(c).toContain("defp serialize(%NaiveDateTime{} = value), do: value");
    // Both must WIN over the struct-dump fallback.
    const dtAt = c.indexOf("defp serialize(%DateTime{}");
    const fallbackAt = c.indexOf("defp serialize(%_{} = struct)");
    expect(dtAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(dtAt);
  });

  it("projects a bare decimal result as a JSON number (RS-24), not %{coef:, exp:, sign:}", async () => {
    const c = await fileEndingWith(SCALAR_SRC, "controllers/sales_api_routes_controller.ex");
    expect(c).toContain("defp serialize(%Decimal{} = value), do: Decimal.to_float(value)");
    const decAt = c.indexOf("defp serialize(%Decimal{}");
    expect(decAt).toBeGreaterThan(-1);
    expect(c.indexOf("defp serialize(%_{} = struct)")).toBeGreaterThan(decAt);
  });

  it("dispatches a bare value-object result to its wireShape serializer (camelCase keys)", async () => {
    const c = await fileEndingWith(SCALAR_SRC, "controllers/sales_api_routes_controller.ex");
    // Both stored key shapes — atom-keyed off a struct field read, string-keyed
    // straight off jsonb.
    expect(c).toContain(
      "defp serialize(%{amount: _, currency_code: _} = value), do: serialize_money_ordering_order(value)",
    );
    expect(c).toContain(
      'defp serialize(%{"amount" => _, "currency_code" => _} = value), do: serialize_money_ordering_order(value)',
    );
    // The target helper projects the VO's camelCase wire keys.
    expect(c).toContain('"currencyCode" => Map.get(record, :currency_code');
    // The VO clauses sit AFTER `%_{}` — a struct matches a bare map pattern too,
    // and the aggregate heads must keep winning — but BEFORE the pass-through.
    const fallbackAt = c.indexOf("defp serialize(%_{} = struct)");
    const voAt = c.indexOf("defp serialize(%{amount: _");
    const otherAt = c.indexOf("defp serialize(other), do: other");
    expect(voAt).toBeGreaterThan(fallbackAt);
    expect(otherAt).toBeGreaterThan(voAt);
  });

  it("is gated: a system whose handlers all return aggregates emits no scalar/VO clauses", async () => {
    const c = await fileEndingWith(NO_SCALAR_SRC, "controllers/sales_api_routes_controller.ex");
    expect(c).not.toContain("%DateTime{}");
    expect(c).not.toContain("%Decimal{} = value");
    expect(c).not.toContain("defp serialize(%{amount: _");
  });
});
