import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Provenance runtime on the vanilla (plain Ecto) foundation — DEBT-06.
//
// A `provenanced` field gets a co-located `<field>_provenance` jsonb backing
// column; every named-operation write to it captures a lineage (rule snapshot
// + leaf inputs + computed value) into a per-process buffer, and the persist
// drains that buffer into the `provenance_records` history table inside the
// save transaction.  The shared `<App>.Provenance` SDK (buffer + flush + the
// pass-through `Json` Ecto type + the `Record` schema) and a high-versioned
// migration (ALTER TABLE backing columns + CREATE TABLE history) ride along.
//
// The Ash foundation has no provenance runtime — only `foundation: vanilla`
// un-gates it (see test/ir/capabilities/provenanced-storage-support.test.ts).
// ---------------------------------------------------------------------------

const SOURCE = `
system Ordering {
  subdomain Sales {
    context Orders {
      aggregate Order {
        quantity: int
        unitPrice: int
        discount: int
        total: int provenanced

        operation reprice(qty: int, price: int) {
          precondition qty > 0
          total := qty * price - discount
        }
        operation applyDiscount(amount: int) {
          precondition amount >= 0
          discount := amount
          total := total - amount
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource orderState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [orderState]
    serves: OrdersApi
    port: 4000
  }
}
`;

// A second system with a non-provenanced aggregate — to assert the runtime is
// gated (no provenance files / migration / capture) when nothing is marked.
const PLAIN = `
system Plain {
  subdomain Core {
    context Stock {
      aggregate Item {
        total: int
        operation bump() { total := total + 1 }
      }
      repository Items for Item { }
    }
  }
  api StockApi from Core
  storage pg { type: postgres }
  resource itemState { for: Stock, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Stock]
    dataSources: [itemState]
    serves: StockApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla provenance runtime (DEBT-06)", () => {
  it("adds the co-located `<field>_provenance` backing column to the schema", async () => {
    const schema = file(await generateSystemFiles(SOURCE), "/orders/order.ex");
    expect(schema).toContain("field :total_provenance, Api.Provenance.Json");
    // The declared columns are untouched.
    expect(schema).toContain("field :total, :integer");
  });

  it("captures lineage inline at each named-op write site", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    // Leaf inputs snapshotted (here: params + the sibling `discount`).
    expect(ctx).toContain('%{path: "qty", value: qty}');
    expect(ctx).toContain('%{path: "discount", value: record.discount}');
    // The lineage map (snapshot id + target + inputs + computed value).
    expect(ctx).toContain('target: %{type: "Order", field: "total"}');
    // camelCase members — the lineage map goes on the wire verbatim (RS-18), so
    // its own keys follow RS-1 like every other wire member.  Only the OUTER
    // `<field>_provenance` key is the snake_case exception.
    expect(ctx).toContain("computedValue: record.total");
    expect(ctx).toContain("snapshotId: ");
    // Routed to both sinks: the co-located column + the trace buffer.
    expect(ctx).toContain("record = %{record | total_provenance:");
    expect(ctx).toContain("Api.Provenance.record(");
  });

  it("snapshots a self-referential write's leaf BEFORE the mutation", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    // applyDiscount does `total := total - amount` — the `record.total` leaf
    // must be captured into the inputs list before the struct rebind.
    const inputsIdx = ctx.indexOf('%{path: "total", value: record.total}');
    const writeIdx = ctx.indexOf("record = %{record | total: record.total - amount}");
    expect(inputsIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(inputsIdx).toBeLessThan(writeIdx);
  });

  it("drains the buffer into the history table inside the save transaction", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    expect(ctx).toContain("Api.Repo.transaction(fn ->");
    expect(ctx).toContain("Api.Provenance.flush(Api.Repo)");
    // The co-located column rides the same changeset as the declared columns.
    expect(ctx).toContain(
      "Ecto.Changeset.force_change(:total_provenance, record.total_provenance)",
    );
  });

  it("emits the Provenance SDK (buffer + flush + Json type + Record schema)", async () => {
    const prov = file(await generateSystemFiles(SOURCE), "/api/provenance.ex");
    expect(prov).toContain("defmodule Api.Provenance.Json do");
    expect(prov).toContain("def type, do: :map");
    expect(prov).toContain('schema "provenance_records" do');
    expect(prov).toContain("def record(lineage) do");
    expect(prov).toContain("def drain do");
    expect(prov).toContain("def flush(repo) do");
    // Governance stamps drawn from the ambient request context.
    expect(prov).toContain("correlation_id: RequestContext.correlation_id()");
    expect(prov).toContain("actor_id: RequestContext.actor_id()");
    // provenance_recorded (debug) announced once per non-empty flush.
    expect(prov).toContain("require Logger");
    expect(prov).toContain('Logger.debug("provenance_recorded"');
    expect(prov).toContain("count: length(rows)");
  });

  it("emits the schema-prefixed ALTER; the history table comes from MigrationsIR", async () => {
    const files = await generateSystemFiles(SOURCE);
    const mig = file(files, "_create_provenance.exs");
    // The orders table lives in the `orders` schema — the ALTER must match.
    expect(mig).toContain('alter table(:orders, prefix: "orders") do');
    expect(mig).toContain("add :total_provenance, :map");
    // The history table's DDL moved to the shared MigrationsIR
    // (`provenanceTableShape`), so it is rendered by the ordinary Ecto
    // migration emitter — including BOTH indexes, and deliberately WITHOUT the
    // bundled `timestamps()` (the flush inserts plain maps via `insert_all`, so
    // a NOT NULL `inserted_at` would reject every provenanced write and roll
    // the aggregate save back with it).
    expect(mig).not.toContain("create table(:provenance_records");
    const created = file(files, "_create_provenance_records.exs");
    expect(created).toContain("create table(:provenance_records, primary_key: false) do");
    expect(created).toContain("create index(:provenance_records, [:target_type, :field])");
    expect(created).toContain("create index(:provenance_records, [:correlation_id])");
    expect(created).not.toContain("timestamps()");
  });

  it("is gated: no provenance files/capture when no field is provenanced", async () => {
    const files = await generateSystemFiles(PLAIN);
    expect([...files.keys()].some((k) => k.endsWith("/provenance.ex"))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("_create_provenance.exs"))).toBe(false);
    const ctx = file(files, "/api/stock.ex");
    expect(ctx).not.toContain("Provenance.record(");
    expect(ctx).not.toContain("Repo.transaction(");
  });
});

// ---------------------------------------------------------------------------
// RS-18 — the CRUDISH UPDATE path.
//
// The generic update persists through `<Agg>Changeset.update_changeset/2` (the
// shape RS-26's present-key / default rules need), so the synthesized
// `operation update(...)` BODY never executes and the inline capture above
// never runs on that path — a provenanced field kept the PREVIOUS write's
// lineage while node/python/java/dotnet all re-captured.  That was the
// `corpus/provenance` wire-golden divergence on `$.total_provenance.inputs`,
// waived in `test/_helpers/wire-waivers.ts` until this landed.
// ---------------------------------------------------------------------------

const CRUDISH = `
system OrderingCrud {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish {
        reference: string
        quantity: int
        unitPrice: int
        discount: int
        total: int provenanced

        operation reprice(qty: int, price: int) {
          precondition qty > 0
          total := qty * price - discount
        }
      }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage pg { type: postgres }
  resource orderState { for: Orders, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [orderState]
    serves: OrdersApi
    port: 4000
  }
}
`;

describe("vanilla provenance — the crudish UPDATE re-captures lineage (RS-18)", () => {
  it("stamps the co-located column off the applied changeset with the update write-site snapshot", async () => {
    const repo = file(await generateSystemFiles(CRUDISH), "/orders/order_repository.ex");
    expect(repo).toContain("defp __capture_provenance(%Ecto.Changeset{} = changeset) do");
    // The proposed row is the value source — a `param` leaf and a `this-prop`
    // leaf alike read as `record.<column>`.  `update` assigns `total := total`,
    // so the lineage names `total`, NOT the previous write's leaves.
    expect(repo).toContain("record = Ecto.Changeset.apply_changes(changeset)");
    expect(repo).toContain('loom_prov_inputs_0 = [%{path: "total", value: record.total}]');
    expect(repo).toContain('target: %{type: "Order", field: "total"}');
    expect(repo).toContain("computedValue: record.total");
    expect(repo).toContain(
      "changeset = Ecto.Changeset.put_change(changeset, :total_provenance, loom_lineage_0)",
    );
  });

  it("routes the update through the capture and flushes the history on success only", async () => {
    const repo = file(await generateSystemFiles(CRUDISH), "/orders/order_repository.ex");
    expect(repo).toContain("|> __capture_provenance()");
    expect(repo).toContain("Repo.transaction(fn ->");
    // Pushed AFTER the save succeeds, so a rejected changeset leaves no
    // orphaned, undrained trace in the per-process buffer.
    const okIdx = repo.indexOf("{:ok, saved} ->");
    const pushIdx = repo.indexOf("Enum.each(lineages, &Api.Provenance.record/1)");
    const flushIdx = repo.indexOf("Api.Provenance.flush(Repo)");
    expect(okIdx).toBeGreaterThan(-1);
    expect(pushIdx).toBeGreaterThan(okIdx);
    expect(flushIdx).toBeGreaterThan(pushIdx);
    expect(repo).toContain("Repo.rollback(reason)");
  });

  it("is gated: a provenanced aggregate with no crudish update keeps the plain pipe", async () => {
    // SOURCE declares no `update` operation, so nothing to re-capture — the
    // update pipe stays byte-identical (`|> Repo.update()`), with no helper.
    const repo = file(await generateSystemFiles(SOURCE), "/orders/order_repository.ex");
    expect(repo).not.toContain("__capture_provenance");
    expect(repo).toContain("|> Repo.update()");
  });
});
