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
      aggregate Order ids guid {
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
      aggregate Item ids guid {
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
    expect(ctx).toContain("computed_value: record.total");
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

  it("emits the schema-prefixed ALTER + the history CREATE migration", async () => {
    const mig = file(await generateSystemFiles(SOURCE), "_create_provenance.exs");
    // The orders table lives in the `orders` schema — the ALTER must match.
    expect(mig).toContain('alter table(:orders, prefix: "orders") do');
    expect(mig).toContain("add :total_provenance, :map");
    expect(mig).toContain("create table(:provenance_records, primary_key: false) do");
    expect(mig).toContain("create index(:provenance_records, [:target_type, :field])");
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
