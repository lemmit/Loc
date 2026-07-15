import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Audit runtime on the vanilla (plain Ecto) foundation — audit-and-logging.md.
//
// An `audited` command action (per-operation `audited`, `create(...) audited`,
// or `destroy audited`) appends a who/what/when + before/after wire snapshot
// row to the `audit_records` table.  The row is recorded INSIDE a forced
// `Repo.transaction` so it commits atomically with the state change:
//   - operation → before = wire(record) pre-body, after = wire(saved) post-save.
//   - create    → before = nil, after = wire(created), recorded AFTER the insert.
//   - destroy   → before = wire(loaded), after = nil, recorded BEFORE the delete.
//
// The shared `<App>.Audit` sink (Record schema + the `Json` Ecto type + the
// transactional `record/2` insert) and a high-versioned migration (one above
// the provenance migration) ride along.  The Ash foundation has no audit
// runtime — only `foundation: vanilla` un-gates it (the validator rejects
// audited actions on Ash; see test/ir/capabilities/audited-operation-support).
// ---------------------------------------------------------------------------

const SOURCE = `
system Auditing {
  subdomain Sales {
    context Orders {
      error NotFound { resource: string }

      aggregate Order {
        status: string
        operation cancel() audited {
          status := "cancelled"
        }
        operation settle() audited: Order or NotFound {
          status := "settled"
        }
        create(status: string) audited {
          status := status
        }
        destroy audited { }
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

// A system with NO audited action — to assert the runtime is gated (no audit
// files / migration / capture) when nothing opts in.
const PLAIN = `
system Plain {
  subdomain Core {
    context Stock {
      aggregate Item with crudish {
        count: int
        operation bump() { count := count + 1 }
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

// A DOCUMENT-shaped aggregate with audited create/destroy — the audit
// before/after must store the FLATTENED wire shape (`serialize/1` = id + data),
// not the nested `%{id:, data: …}` struct dump (cross-backend wire parity).
const DOC = `
system DocAudit {
  subdomain Sales {
    context Carts {
      aggregate Cart shape: document with crudish {
        reference: string
        create(reference: string) audited {
          reference := reference
        }
        destroy audited { }
      }
      repository Carts for Cart { }
    }
  }
  api CartsApi from Sales
  storage pg { type: postgres }
  resource cartState { for: Carts, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Carts]
    dataSources: [cartState]
    serves: CartsApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla audit runtime (audit-and-logging.md)", () => {
  it("emits the Audit SDK (Record schema + Json type + transactional record/2)", async () => {
    const audit = file(await generateSystemFiles(SOURCE), "/api/audit.ex");
    expect(audit).toContain("defmodule Api.Audit.Json do");
    expect(audit).toContain("def type, do: :map");
    expect(audit).toContain('schema "audit_records" do');
    expect(audit).toContain("@primary_key {:audit_id, :string, autogenerate: false}");
    expect(audit).toContain("def record(repo, fields) when is_map(fields) do");
    // Governance stamps drawn from the ambient request context.
    expect(audit).toContain("correlation_id: RequestContext.correlation_id()");
    expect(audit).toContain("scope_id: RequestContext.scope_id()");
    expect(audit).toContain("parent_id: RequestContext.parent_id()");
    expect(audit).toContain("actor_id = RequestContext.actor_id()");
  });

  it("emits the audit_records migration with the byte-shared columns + indexes", async () => {
    const mig = file(await generateSystemFiles(SOURCE), "_create_audit.exs");
    // Distinct higher version than provenance (29991231000000) so both late
    // migrations sort deterministically.
    expect(
      [...(await generateSystemFiles(SOURCE)).keys()].some((k) =>
        k.endsWith("29991231000001_create_audit.exs"),
      ),
    ).toBe(true);
    expect(mig).toContain("create table(:audit_records, primary_key: false) do");
    expect(mig).toContain("add :audit_id, :string, primary_key: true, null: false");
    expect(mig).toContain("add :operation_id, :string, null: false");
    expect(mig).toContain("add :action, :string, null: false");
    expect(mig).toContain("add :target_type, :string, null: false");
    expect(mig).toContain("add :target_id, :string, null: false");
    expect(mig).toContain("add :actor, :map");
    expect(mig).toContain("add :before, :map");
    expect(mig).toContain("add :after, :map");
    expect(mig).toContain("add :status, :string, null: false");
    expect(mig).toContain("create index(:audit_records, [:target_type, :target_id])");
    expect(mig).toContain("create index(:audit_records, [:correlation_id])");
  });

  it("wraps the audited OPERATION persist in a forced transaction + records before/after", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    // `before` snapshot is taken from the original record before the body runs.
    expect(ctx).toContain(
      "audit_before = (record |> Map.from_struct() |> Map.drop([:__meta__, :__struct__]))",
    );
    // Forced transaction tail (no provenance here — audit alone forces it).
    expect(ctx).toContain("Api.Repo.transaction(fn ->");
    expect(ctx).toContain("Api.Audit.record(Api.Repo, %{");
    expect(ctx).toContain('operation_id: "cancelOrder"');
    expect(ctx).toContain('action: "cancel"');
    expect(ctx).toContain('target_type: "Order"');
    expect(ctx).toContain("target_id: saved.id");
    expect(ctx).toContain("before: audit_before");
    expect(ctx).toContain(
      "after: (saved |> Map.from_struct() |> Map.drop([:__meta__, :__struct__]))",
    );
  });

  it("wraps the audited RETURNING operation persist in a forced transaction + records before/after(saved)", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    // The returning fn — distinct from the non-returning `cancel` — must now
    // persist + record an audit row on the success branch, not silently drop it.
    const settleIdx = ctx.indexOf("def settle_order(");
    expect(settleIdx).toBeGreaterThan(-1);
    const settle = ctx.slice(settleIdx);
    // `before` snapshot taken before the body rebinds any field.
    expect(settle).toContain(
      "audit_before = (record |> Map.from_struct() |> Map.drop([:__meta__, :__struct__]))",
    );
    // The persist runs inside a forced transaction (audit alone forces it).
    expect(settle).toContain("Api.Repo.transaction(fn ->");
    expect(settle).toContain("case Api.Orders.OrderRepository.persist_change(changeset) do");
    expect(settle).toContain("Api.Audit.record(Api.Repo, %{");
    expect(settle).toContain('operation_id: "settleOrder"');
    expect(settle).toContain('action: "settle"');
    expect(settle).toContain('target_type: "Order"');
    expect(settle).toContain("target_id: saved.id");
    expect(settle).toContain("before: audit_before");
    // `after` is the SAVED aggregate state (post-save), regardless of union arm.
    expect(settle).toContain(
      "after: (saved |> Map.from_struct() |> Map.drop([:__meta__, :__struct__]))",
    );
    // The audit insert must NOT change the controller-facing return shape — the
    // success branch returns the wire map (the controller `json`s it).
    expect(settle).toContain("%{id: saved.id, status: saved.status, version: saved.version}");
  });

  it("maps the returning audited op's persist-failure to a 422 (validation clause)", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/order_controller.ex");
    // The `_result/2` helper gains an Ecto.Changeset clause because the op now
    // persists inside a transaction (a validation failure rolls back to a 2-tuple).
    expect(ctrl).toContain(
      "def settle_order_result(conn, {:ok, success}), do: json(conn, success)",
    );
    expect(ctrl).toContain('def settle_order_result(conn, {:error, "NotFound", data}),');
    expect(ctrl).toContain(
      "def settle_order_result(conn, {:error, %Ecto.Changeset{} = changeset}),",
    );
  });

  it("emits the audit_recorded log line (catalog debug event) after the insert, inside record/2", async () => {
    const audit = file(await generateSystemFiles(SOURCE), "/api/audit.ex");
    // The Audit module logs, so it must `require Logger`.
    expect(audit).toContain("require Logger");
    // One catalog line per audited insert — fired from the shared sink so every
    // audited action (operation / create / destroy) gets it for free, with
    // action/target/actor all in scope.  `event:` is re-stamped for cross-backend
    // pivoting; level is debug (Elixir maps catalog `debug` → `Logger.debug`).
    expect(audit).toContain(
      'Logger.debug("audit_recorded", event: "audit_recorded", action: row.action, ' +
        'target: "#{row.target_type}/#{row.target_id}", actor: actor_id)',
    );
    // The log fires AFTER the row commits and the insert's return value is still
    // handed back unchanged (record/2's contract is the inserted Record).
    expect(audit).toContain("inserted = repo.insert!(struct(Record, row))");
    const logIdx = audit.indexOf('Logger.debug("audit_recorded"');
    const insertIdx = audit.indexOf("inserted = repo.insert!");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(logIdx).toBeGreaterThan(insertIdx);
  });

  it("does not emit audit_recorded (or require Logger for it) when nothing is audited", async () => {
    const files = await generateSystemFiles(PLAIN);
    // Gated with the whole audit runtime — no audit.ex, so no audit_recorded.
    expect([...files.keys()].some((k) => k.endsWith("/audit.ex"))).toBe(false);
    for (const content of files.values()) {
      expect(content).not.toContain("audit_recorded");
    }
  });

  it("inserts the audit row with the raising insert!/1 so a failure rolls the txn back", async () => {
    const audit = file(await generateSystemFiles(SOURCE), "/api/audit.ex");
    // insert!/1 (not insert/1): a failed audit insert must raise → roll back the
    // whole action transaction (the atomic-commit guarantee), matching Python.
    expect(audit).toContain("repo.insert!(struct(Record, row))");
    expect(audit).not.toContain("repo.insert(struct(Record, row))");
    expect(audit).toContain("@spec record(module(), map()) :: Record.t()");
  });

  it("audits the CREATE with before:nil / after=wire(created) AFTER the insert", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/order_controller.ex");
    expect(ctrl).toContain("def create(conn, params) do");
    // Forced transaction around the insert.
    expect(ctrl).toContain("Api.Repo.transaction(fn ->");
    expect(ctrl).toContain("case Orders.create_order(params) do");
    expect(ctrl).toContain('operation_id: "createOrder"');
    expect(ctrl).toContain('action: "create"');
    expect(ctrl).toContain("target_id: record.id");
    expect(ctrl).toContain("before: nil");
    // `after` uses the controller's own `serialize/1` (in scope here) so a
    // document-shaped aggregate records the flattened wire shape, not the nested
    // `%{id:, data: …}` struct dump — wire-parity with the other backends.
    expect(ctrl).toContain("after: serialize(record)");
  });

  it("audits the DESTROY with before=wire(loaded) / after:nil BEFORE the delete", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/order_controller.ex");
    expect(ctrl).toContain('def delete(conn, %{"id" => id}) do');
    expect(ctrl).toContain('operation_id: "destroyOrder"');
    expect(ctrl).toContain('action: "destroy"');
    expect(ctrl).toContain("target_id: id");
    // `before` uses the controller's own `serialize/1` (doc-aware) so the wire
    // shape recorded matches the other backends + this controller's own bodies.
    expect(ctrl).toContain("before: serialize(record)");
    expect(ctrl).toContain("after: nil");
    // The audit row is recorded inside the transaction, BEFORE the delete call.
    const auditIdx = ctrl.indexOf('operation_id: "destroyOrder"');
    const deleteIdx = ctrl.indexOf("case Orders.delete_order(record) do");
    expect(auditIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeLessThan(deleteIdx);
  });

  it("records the FLATTENED wire shape for a document-storage aggregate (serialize/1, not the struct dump)", async () => {
    const ctrl = file(await generateSystemFiles(DOC), "/cart_controller.ex");
    // The doc agg's serialize/1 is the flattened wire shape — the wireShape
    // projection (§14) rooted at the embed (Route A slice 4): each stored field
    // keyed by its declared camelCase name off `record = row.data`.
    expect(ctrl).toContain("defp serialize(row) do");
    expect(ctrl).toContain("record = row.data");
    expect(ctrl).toContain('"reference" => record.reference');
    // create audit `after` + destroy audit `before` route through serialize/1, so
    // they carry the flattened wire shape — NOT the nested `%{id:, data: …}` dump.
    expect(ctrl).toContain("after: serialize(record)");
    expect(ctrl).toContain("before: serialize(record)");
    // And specifically NOT the struct-drop projection (which on a doc agg would
    // capture the nested `{id, data}` row instead of the flattened document).
    expect(ctrl).not.toContain(
      "after: (record |> Map.from_struct() |> Map.drop([:__meta__, :__struct__]))",
    );
  });

  it("is gated: no audit files/capture when nothing is audited", async () => {
    const files = await generateSystemFiles(PLAIN);
    expect([...files.keys()].some((k) => k.endsWith("/audit.ex"))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("_create_audit.exs"))).toBe(false);
    const ctx = file(files, "/api/stock.ex");
    expect(ctx).not.toContain("Audit.record(");
    // A non-audited op stays a plain changeset pipe (no forced transaction).
    expect(ctx).not.toContain("Repo.transaction(");
  });
});
