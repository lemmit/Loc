import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Slice 8 (vanilla foundation) — Custom repository finds.
//
// A repository `find` lowers to a function on the per-aggregate
// repository module + a defdelegate on the context facade:
//
//   repository Customers for Customer {
//     find byEmail(email: string): Customer? where this.email == email
//   }
//
// emits, in lib/<app>/<ctx>/<agg>_repository.ex:
//
//   def by_email(email) do
//     query = from(record in Customer, where: record.email == ^email)
//     {:ok, Repo.one(query)}
//   end
//
// and the context facade gains:
//
//   defdelegate by_email_customer(email), to: Api.Orders.CustomerRepository, as: :by_email
//
// Return-type matters: `Customer?` (optional) uses `Repo.one`; `Customer[]`
// (array) uses `Repo.all`.  Convention-finds without an explicit `where`
// fall through to a per-param `record.<name> == ^<name>` predicate (the
// source-level convention from examples/sales.ddd).
//
// Closes the last body-lowering TODO: workflow `repo-let` for a non-getById
// method now routes through the custom-find defdelegate.
// ---------------------------------------------------------------------------

const SOURCE = `
system Sales {
  subdomain Core {
    context Orders {
      enum OrderStatus { Draft, Confirmed, Shipped }
      aggregate Customer with crudish {
        name: string
        email: string
      }
      aggregate Order with crudish {
        customerId: Customer id
        status: OrderStatus
      }
      repository Customers for Customer {
        find byEmail(email: string): Customer? where this.email == email
      }
      repository Orders for Order {
        find byCustomer(customerId: Customer id): Order[]
        find byStatus(s: OrderStatus): Order[] where this.status == s
      }

      workflow tagFirstByEmail {
        create(needle: string) {
          let c = Customers.byEmail(needle)
        }
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

describe("vanilla — custom find functions on the repository module", () => {
  it("emits `import Ecto.Query` only when at least one custom find is declared", async () => {
    const files = await load();
    const customer = files.get(
      [...files.keys()].find((k) => k.endsWith("/customer_repository.ex"))!,
    )!;
    expect(customer).toContain("import Ecto.Query");
  });

  it("an optional-return find uses `Repo.one(query)`", async () => {
    const files = await load();
    const customer = files.get(
      [...files.keys()].find((k) => k.endsWith("/customer_repository.ex"))!,
    )!;
    expect(customer).toContain(
      "def by_email(email) do\n    query = from(record in Api.Orders.Customer, where: record.email == ^email)\n    {:ok, Repo.one(query)}\n  end",
    );
  });

  it("an array-return find uses `Repo.all(query)`", async () => {
    const files = await load();
    const order = files.get([...files.keys()].find((k) => k.endsWith("/order_repository.ex"))!)!;
    expect(order).toContain(
      "def by_status(s) do\n    query = from(record in Api.Orders.Order, where: record.status == ^s)\n    {:ok, Repo.all(query)}\n  end",
    );
  });

  it("a convention-find (no explicit `where`) generates per-param equality predicates", async () => {
    const files = await load();
    const order = files.get([...files.keys()].find((k) => k.endsWith("/order_repository.ex"))!)!;
    // `find byCustomer(customerId: Customer id): Order[]` — no where clause,
    // so the predicate is per-param `record.<name> == ^<name>`.
    expect(order).toMatch(
      /def by_customer\(customer_id\) do\n\s+query = from\(record in Api\.Orders\.Order, where: record\.customer_id == \^customer_id\)/,
    );
  });

  it("the enrichment-synthesized `all` find is dropped (would collide with list/0)", async () => {
    const files = await load();
    const customer = files.get(
      [...files.keys()].find((k) => k.endsWith("/customer_repository.ex"))!,
    )!;
    // No `def all(...)` — the CRUD `list/0` already covers it; emitting
    // `all/0` would duplicate the seam.
    expect(customer).not.toMatch(/def all\(/);
  });

  it("a repository with NO custom finds emits NO Ecto.Query import (byte-shape regression)", async () => {
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
    const task = files.get([...files.keys()].find((k) => k.endsWith("/task_repository.ex"))!)!;
    expect(task).not.toContain("import Ecto.Query");
    // Regression: an empty findBlock must NOT collapse the persist_change
    // `end` into the module's `end` (the `endend` mix-compile bug from CI).
    expect(task).not.toContain("endend");
    expect(task).toMatch(/Repo\.update\(changeset\)\n {2}end\nend\n?$/);

    // Regression: the per-aggregate context block must end with `\n` so the
    // module's `end` doesn't fuse with the last member (the `as: :deleteend`
    // mix-compile bug — TokenMissingError from CI).  `Task with crudish` has a
    // `destroy` action, so the block's tail is now the `destroy_<agg>!` bang
    // function (the DestroyForm seam, gap §10), emitted after `change_<agg>`;
    // its `end` is separated from the module's `end` by a newline.
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/lib/api/tracker.ex"))!)!;
    expect(ctx).not.toContain(":deleteend");
    expect(ctx).toContain(
      "def change_task(record_or_struct \\\\ %Api.Tracker.Task{}, attrs \\\\ %{}),\n    do: Api.Tracker.TaskChangeset.base_changeset(record_or_struct, attrs)",
    );
    expect(ctx).toMatch(/def destroy_task!\(id\) do/);
    expect(ctx).toMatch(/end\n {2}end\nend\n?$/);
  });
});

describe("vanilla — context facade defdelegates custom finds", () => {
  it("emits one `defdelegate <find>_<agg>(args)` per custom find", async () => {
    const files = await load();
    const ctx = files.get([...files.keys()].find((k) => k.endsWith("/lib/api/orders.ex"))!)!;
    expect(ctx).toContain(
      "defdelegate by_email_customer(email), to: Api.Orders.CustomerRepository, as: :by_email",
    );
    expect(ctx).toContain(
      "defdelegate by_customer_order(customer_id), to: Api.Orders.OrderRepository, as: :by_customer",
    );
    expect(ctx).toContain(
      "defdelegate by_status_order(s), to: Api.Orders.OrderRepository, as: :by_status",
    );
  });
});

describe("vanilla — workflow `repo-let` routes a non-getById method through the context defdelegate", () => {
  it("`let c = Customers.byEmail(needle)` lowers to a Context.by_email_customer with-clause", async () => {
    const files = await load();
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/tag_first_by_email.ex"))!,
    )!;
    expect(wf).toContain("{:ok, c} <- Context.by_email_customer(needle)");
  });

  it("the param ref (`needle`) is destructured off run/1 params", async () => {
    const files = await load();
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/tag_first_by_email.ex"))!,
    )!;
    expect(wf).toContain(`%{"needle" => needle} = params`);
  });

  it("no `# TODO: lower workflow statement kind 'repo-let'` comment appears", async () => {
    const files = await load();
    const wf = files.get(
      [...files.keys()].find((k) => k.endsWith("/workflows/tag_first_by_email.ex"))!,
    )!;
    expect(wf).not.toContain("# TODO: lower workflow statement kind 'repo-let'");
  });
});
