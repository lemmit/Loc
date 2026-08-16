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
