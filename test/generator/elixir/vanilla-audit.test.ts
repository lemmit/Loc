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
      aggregate Cart shape: document {
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

// A `mask unless` aggregate with an audited operation — the audit snapshot must
// record the REAL value (authorization.md §5), so `Audit.Wire` projects through
// the aggregate's UNMASKED serializer, never the redacting one.
const MASKED = `
system MaskedAudit {
  user { id: string role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Sales {
    context Orders {
      aggregate Order {
        status: string
        secretNote: string mask unless currentUser.role == "admin"
        operation cancel() audited { status := "cancelled" }
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
    auth: required
  }
}
`;

// A multi-word field + BOTH an audited operation and an audited create — the
// pair whose snapshots used to disagree (`commit_sha` from the operation's
// struct dump vs `commitSha` from the create's wire serializer).
const WIRE = `
system WireAudit {
  subdomain Sales {
    context Orders {
      aggregate Order {
        commitSha: string
        buildState: string
        operation cancel() audited { buildState := "cancelled" }
        create(commitSha: string) audited { commitSha := commitSha }
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

  // The audit DDL is no longer a hand-written late `_create_audit.exs`; it now
  // comes from the shared MigrationsIR (`auditTableShape`) and is rendered by
  // the ordinary Ecto migration emitter alongside every other table.
  it("emits the audit_records DDL through the shared migration emitter", async () => {
    const files = await generateSystemFiles(SOURCE);
    const mig = [...files.entries()].find(
      ([p, c]) => p.includes("priv/repo/migrations/") && c.includes("audit_records"),
    );
    expect(mig, "audit_records DDL must be emitted somewhere").toBeDefined();
    const sql = mig![1];
    expect(sql).toContain("audit_records");
    expect(sql).toContain(":operation_id");
    expect(sql).toContain(":target_type");
    // `before`/`after` must stay NULLABLE — a create has no before, a destroy
    // no after.  A NOT NULL here rolls back the whole action transaction.
    expect(sql).not.toMatch(/:before[^\n]*null: false/);
    expect(sql).not.toMatch(/:after[^\n]*null: false/);
    // `timestamps()` must NOT be bundled: the audit writer builds the row by
    // hand and never populates Ecto timestamps, so a NOT NULL `inserted_at`
    // would reject every audited command.
    expect(sql).not.toMatch(/audit_records[\s\S]{0,600}?timestamps\(\)/);
    // Both indexes survive the move.  They did not, at first: the Ecto emitter's
    // id-less-table branch rendered columns and stopped, which was invisible
    // while every id-less table (outbox, saga state, projection read model)
    // declared no index — `audit_records` was the first to arrive with two.  The
    // failure is silent (reads just scan) and it desynchronises fresh-create
    // from migrate-chain, since the DELTA path always rendered them.
    expect(sql).toContain("create index(:audit_records, [:target_type, :target_id])");
    expect(sql).toContain("create index(:audit_records, [:correlation_id])");
  });

  it("wraps the audited OPERATION persist in a forced transaction + records before/after", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    // `before` snapshot is taken from the original record before the body runs,
    // and projects through the SHARED wire dispatcher (`Audit.Wire.wire/1`) —
    // the same `wireShape` body the create/destroy capture records.
    expect(ctx).toContain("audit_before = Api.Audit.Wire.wire(record)");
    expect(ctx).not.toContain("Map.from_struct()");
    // Forced transaction tail (no provenance here — audit alone forces it).
    expect(ctx).toContain("Api.Repo.transaction(fn ->");
    expect(ctx).toContain("Api.Audit.record(Api.Repo, %{");
    expect(ctx).toContain('operation_id: "cancelOrder"');
    expect(ctx).toContain('action: "cancel"');
    expect(ctx).toContain('target_type: "Order"');
    expect(ctx).toContain("target_id: saved.id");
    expect(ctx).toContain("before: audit_before");
    expect(ctx).toContain("after: Api.Audit.Wire.wire(saved)");
  });

  it("wraps the audited RETURNING operation persist in a forced transaction + records before/after(saved)", async () => {
    const ctx = file(await generateSystemFiles(SOURCE), "/api/orders.ex");
    // The returning fn — distinct from the non-returning `cancel` — must now
    // persist + record an audit row on the success branch, not silently drop it.
    const settleIdx = ctx.indexOf("def settle_order(");
    expect(settleIdx).toBeGreaterThan(-1);
    const settle = ctx.slice(settleIdx);
    // `before` snapshot taken before the body rebinds any field — same shared
    // wire dispatcher as the non-returning path.
    expect(settle).toContain("audit_before = Api.Audit.Wire.wire(record)");
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
    expect(settle).toContain("after: Api.Audit.Wire.wire(saved)");
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

// ---------------------------------------------------------------------------
// The audit SNAPSHOT shape (the `Audit.Wire` dispatcher).
//
// An audit row's before/after is a WIRE body, not a database row: the timeline
// and the `changes` diff derived from it are a cross-backend contract, and
// node/.NET/Java/Python all snapshot the aggregate's `wireShape`.  This backend
// captured create/destroy in the REST controller (where `serialize/1` is in
// scope) but the OPERATION capture in the context module — which hosts no
// serializer — so it dumped the raw Ecto struct.  Two audited actions on ONE
// aggregate wrote two different key spellings into one table.
// ---------------------------------------------------------------------------
describe("vanilla audit snapshot shape — Audit.Wire", () => {
  it("emits an Audit.Wire dispatcher projecting each hosted aggregate's wireShape", async () => {
    const audit = file(await generateSystemFiles(WIRE), "/api/audit.ex");
    expect(audit).toContain("defmodule Api.Audit.Wire do");
    expect(audit).toContain("def wire(record), do: serialize(record)");
    expect(audit).toContain(
      "defp serialize(%Api.Orders.Order{} = record), do: serialize_orders_order(record)",
    );
    // camelCase wire keys, verbatim from `wireShape` — NOT the Ecto columns.
    expect(audit).toContain('"commitSha" => record.commit_sha');
    // Ecto's `timestamps()` columns are in no backend's wire shape, and the
    // struct dump leaked both into every operation audit row.
    expect(audit).not.toContain("inserted_at");
    expect(audit).not.toContain("updated_at");
    // The struct-drop clause survives only as the non-aggregate fallback,
    // behind the aggregate head.
    const dispatchAt = audit.indexOf("defp serialize(%Api.Orders.Order{}");
    const fallbackAt = audit.indexOf("defp serialize(%_{} = struct)");
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(dispatchAt);
  });

  it("the OPERATION snapshot is byte-identical to the create/destroy one", async () => {
    const files = await generateSystemFiles(WIRE);
    // create captures in the controller, through that controller's `serialize/1`
    const ctrl = file(files, "/order_controller.ex");
    const ctrlBody = ctrl.slice(ctrl.indexOf("defp serialize(record) do"));
    const ctrlMap = ctrlBody.slice(ctrlBody.indexOf("%{"), ctrlBody.indexOf("\n  end"));
    // the operation captures through Audit.Wire
    const audit = file(files, "/api/audit.ex");
    const wireBody = audit.slice(audit.indexOf("defp serialize_orders_order(record) do"));
    const wireMap = wireBody.slice(wireMap0(wireBody), wireBody.indexOf("\n  end"));
    expect(wireMap).toBe(ctrlMap);
  });

  it("a masked aggregate snapshots UNMASKED (the history holds the real value)", async () => {
    const audit = file(await generateSystemFiles(MASKED), "/api/audit.ex");
    // The dispatch targets the unmasked projection, and the redacting
    // `serialize_<sfx>` is not emitted at all — nothing would call it, and an
    // unreferenced private fn fails `mix compile --warnings-as-errors`.
    expect(audit).toContain(
      "defp serialize(%Api.Orders.Order{} = record), do: serialize_unmasked_orders_order(record)",
    );
    expect(audit).toContain("defp serialize_unmasked_orders_order(record) do");
    expect(audit).not.toContain("defp serialize_orders_order(record) do");
    expect(audit).not.toContain("Process.get(:loom_current_user)");
    expect(audit).toContain('"secretNote" => record.secret_note');
  });
});

/** Index of the `%{` opening the wire map in a rendered `serialize_*` body. */
function wireMap0(body: string): number {
  return body.indexOf("%{");
}
