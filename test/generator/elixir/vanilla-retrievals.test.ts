import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 7 (vanilla foundation) — Retrieval emission.
//
// On `foundation: vanilla` a `retrieval` lowers to a plain Ecto query
// module under `lib/<app>/<ctx>/retrievals/<name>.ex`:
//
//     def run(arg1, arg2, ..., opts \\ []) do
//       query = from(record in <Agg>, where: <predicate>)
//       query = if opts[:limit], do: limit(query, ^opts[:limit]), else: query
//       query = if opts[:offset], do: offset(query, ^opts[:offset]), else: query
//       query = order_by(query, [record], [<dir>: record.<field>, ...])
//       {:ok, Repo.all(query)}
//     end
//
// The context facade adds `defdelegate run_<ret>_<agg>(args..., opts \\ [])`
// so a workflow's `repo-run` lowering (a separate follow-up slice) can
// call through the context seam.
//
// The `where` predicate uses `filterArgs: true` + `foundation: "vanilla"`
// so a declared retrieval param renders as Ecto's `^name` pin form (not
// Ash's `^arg(:name)`), and an `enum-value` is the stored string column
// (`"confirmed"`) rather than an atom (`:confirmed`).
//
// `repo-run` + `for-each` workflow lowerings stay on the `# TODO`
// fallthrough until a follow-up slice consumes the new run_<ret>_<agg>
// seam.  The validator `loom.workflow-foreach-source` keeps `for-each`
// independently gated until then.
// ---------------------------------------------------------------------------

const SOURCE = `
system Sales {
  subdomain Core {
    context Orders {
      enum OrderStatus { Draft, Confirmed, Shipped }
      aggregate Order with crudish {
        sku: string
        status: OrderStatus
        placedAt: datetime
      }
      repository Orders for Order { }

      retrieval ByStatus(s: OrderStatus) of Order {
        where: this.status == s
        sort:  [placedAt desc]
      }

      retrieval AllPending() of Order {
        where: this.sku != ""
      }
    }
  }
  api OrdersApi from Core
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

async function load(): Promise<Map<string, string>> {
  return generateSystemFiles(SOURCE);
}

describe("vanilla — retrieval modules under lib/<app>/<ctx>/retrievals/", () => {
  it("emits one module per retrieval", async () => {
    const files = await load();
    expect([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))).toBeDefined();
    expect([...files.keys()].find((k) => k.endsWith("/retrievals/all_pending.ex"))).toBeDefined();
  });

  it("imports Ecto.Query and aliases the project's Repo", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    expect(body).toContain("import Ecto.Query");
    expect(body).toContain("alias Api.Repo");
  });

  it("renders the from/where over the aggregate schema with `record` binding", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    // The predicate is rendered against Api.Orders.Order with `record` as
    // the Ecto binding (matching the existing vanilla view-emit shape).
    expect(body).toMatch(/from\(record in Api\.Orders\.Order, where: record\.status == \^s\)/);
  });

  it("renders a declared param as Ecto's `^name` pin (NOT Ash's `^arg(:name)`)", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    // foundation: "vanilla" + filterArgs: true → bare pin.
    expect(body).toContain("^s");
    expect(body).not.toContain("^arg(:");
  });

  it("conditionally applies limit/offset opts to the query", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    expect(body).toContain("if opts[:limit], do: limit(query, ^opts[:limit]), else: query");
    expect(body).toContain("if opts[:offset], do: offset(query, ^opts[:offset]), else: query");
  });

  it("renders the sort clause as `order_by(query, [record], [<dir>: record.<field>])`", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    expect(body).toContain("order_by(query, [record], [desc: record.placed_at])");
  });

  it("a retrieval with no params still takes a default opts arg", async () => {
    const files = await load();
    const body = files.get(
      [...files.keys()].find((k) => k.endsWith("/retrievals/all_pending.ex"))!,
    )!;
    expect(body).toContain("def run(opts \\\\ [])");
  });

  it("a retrieval with no sort omits the order_by line", async () => {
    const files = await load();
    const body = files.get(
      [...files.keys()].find((k) => k.endsWith("/retrievals/all_pending.ex"))!,
    )!;
    expect(body).not.toContain("order_by(");
  });

  it("returns `{:ok, Repo.all(query)}` (the contract that repo-run lowering will consume)", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    expect(body).toContain("{:ok, Repo.all(query)}");
  });

  it("no Ash references appear in the emitted module", async () => {
    const files = await load();
    const body = files.get([...files.keys()].find((k) => k.endsWith("/retrievals/by_status.ex"))!)!;
    expect(body).not.toContain("Ash.");
    expect(body).not.toContain("use Ash.Resource");
  });
});

describe("vanilla — context facade defdelegates retrievals", () => {
  it("emits a `defdelegate run_<retrieval>_<agg>(args..., opts) ` per retrieval", async () => {
    const files = await load();
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/lib/api/orders.ex"))!)!;
    expect(ctx).toContain(
      "defdelegate run_by_status_order(s, opts \\\\ []), to: Api.Orders.Retrievals.ByStatus, as: :run",
    );
    expect(ctx).toContain(
      "defdelegate run_all_pending_order(opts \\\\ []), to: Api.Orders.Retrievals.AllPending, as: :run",
    );
  });
});

describe("vanilla — no-retrievals byte-shape regression", () => {
  it("a context without retrievals emits no retrievals/ directory + no defdelegates", async () => {
    const files = await generateSystemFiles(`
      system Tasks {
        subdomain Productivity {
          context Tracker {
            aggregate Task with crudish { title: string }
            repository Tasks for Task { }
          }
        }
        api TrackerApi from Productivity
        storage primary { type: postgres }
        resource trackerState { for: Tracker, kind: state, use: primary }
        deployable api {
          platform: elixir
          contexts: [Tracker]
          dataSources: [trackerState]
          serves: TrackerApi
          port: 4000
        }
      }
    `);
    expect([...files.keys()].some((k) => k.includes("/retrievals/"))).toBe(false);
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/lib/api/tracker.ex"))!)!;
    expect(ctx).not.toContain("# Retrievals");
    expect(ctx).not.toContain("defdelegate run_");
  });
});
