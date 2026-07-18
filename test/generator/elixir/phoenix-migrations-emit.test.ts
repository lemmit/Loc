import { describe, expect, it } from "vitest";

import { emitMigrations } from "../../../src/generator/elixir/migrations-emit.js";
import type { MigrationsIR, SchemaSnapshot } from "../../../src/ir/types/migrations-ir.js";

// ---------------------------------------------------------------------------
// Phoenix migrations-emit — unit tests for the delta path (subsequent
// regens, baseline !== null).  Initial-migration emission is covered
// by the system pipeline test.
// ---------------------------------------------------------------------------

const APP_MODULE = "PhoenixApp";

const EMPTY_SNAP: SchemaSnapshot = {
  schemaVersion: 1,
  lastVersion: "20260101000000",
  tables: [],
};

function emit(ir: MigrationsIR): Map<string, string> {
  const out = new Map<string, string>();
  emitMigrations("phoenix_app", [ir], APP_MODULE, out);
  return out;
}

describe("phoenix migrations-emit — delta path", () => {
  it("renders one alter table block per addColumn step", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: EMPTY_SNAP,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "addColumn",
          table: "orders",
          column: { name: "note", type: { kind: "text" }, nullable: true },
        },
      ],
      version: "20260101000001",
      name: "AddNoteToOrders",
    };
    const files = emit(ir);
    const path = "priv/repo/migrations/20260101000001_add_note_to_orders.exs";
    expect(files.has(path)).toBe(true);
    const body = files.get(path)!;
    expect(body).toMatch(/defmodule PhoenixApp\.Repo\.Migrations\.AddNoteToOrders do/);
    expect(body).toMatch(/alter table\(:orders\) do/);
    expect(body).toMatch(/add :note, :text, null: true/);
  });

  it("renders references(...) for an FK-carrying addColumn", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: EMPTY_SNAP,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "addColumn",
          table: "orders",
          column: { name: "customer", type: { kind: "uuid" }, nullable: false },
          fk: { column: "customer", refTable: "customers", onDelete: "restrict" },
        },
      ],
      version: "20260101000002",
      name: "AddCustomerToOrders",
    };
    const files = emit(ir);
    const body = files.get("priv/repo/migrations/20260101000002_add_customer_to_orders.exs")!;
    expect(body).toMatch(
      /add :customer, references\(:customers, type: :uuid, on_delete: :restrict\), null: false/,
    );
  });

  it("renders dropColumn / dropTable / addIndex steps", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: EMPTY_SNAP,
      next: EMPTY_SNAP,
      steps: [
        { op: "dropColumn", table: "orders", name: "legacy_note" },
        { op: "dropTable", name: "old_table" },
        {
          op: "addIndex",
          index: { name: "orders_status_idx", table: "orders", columns: ["status"], unique: false },
        },
      ],
      version: "20260101000003",
      name: "Cleanup",
    };
    const files = emit(ir);
    const body = files.get("priv/repo/migrations/20260101000003_cleanup.exs")!;
    expect(body).toMatch(/remove :legacy_note/);
    expect(body).toMatch(/drop table\(:old_table\)/);
    expect(body).toMatch(/create index\(:orders, \[:status\]\)/);
  });

  it("renders a renameTable step as an Ecto `rename table(...), to: table(...)` (M-T2.1)", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: EMPTY_SNAP,
      next: EMPTY_SNAP,
      steps: [
        { op: "renameTable", from: "orders", to: "purchase_orders" },
        { op: "renameTable", from: "orders", to: "purchase_orders", schema: "sales" },
      ],
      version: "20260101000004",
      name: "RenameOrdersToPurchaseOrders",
    };
    const body = emit(ir).get(
      "priv/repo/migrations/20260101000004_rename_orders_to_purchase_orders.exs",
    )!;
    expect(body).toMatch(/rename table\(:orders\), to: table\(:purchase_orders\)/);
    // Schema-qualified rename carries the prefix on both ends.
    expect(body).toMatch(
      /rename table\(:orders, prefix: "sales"\), to: table\(:purchase_orders, prefix: "sales"\)/,
    );
  });

  it("modifies a column with its current type on a nullability flip", () => {
    // Ecto's `modify` requires the type to be re-stated even when only
    // nullability changes — the step carries it so the emitter doesn't
    // have to guess (the pre-fix bug hardcoded `:text`, silently
    // converting the column's type).
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: EMPTY_SNAP,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "alterColumnNullable",
          table: "orders",
          name: "total",
          type: { kind: "int" },
          nullable: true,
        },
      ],
      version: "20260101000010",
      name: "MakeTotalOptional",
    };
    const body = emit(ir).get("priv/repo/migrations/20260101000010_make_total_optional.exs")!;
    expect(body).toMatch(/modify :total, :integer, null: true/);
  });

  it("is a no-op when steps is empty", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: EMPTY_SNAP,
      next: EMPTY_SNAP,
      steps: [],
      version: "20260101000004",
      name: "Migrate",
    };
    const files = emit(ir);
    expect(files.size).toBe(0);
  });

  it("renders initial-migration createTable steps as one file per top-level table", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: null,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "createTable",
          table: {
            name: "orders",
            ownerModule: "Sales",
            columns: [
              { name: "id", type: { kind: "uuid" }, nullable: false },
              { name: "total", type: { kind: "int" }, nullable: false },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
            indexes: [],
          },
        },
        {
          op: "createTable",
          table: {
            name: "order_lines",
            ownerModule: "Sales",
            columns: [
              { name: "id", type: { kind: "uuid" }, nullable: false },
              { name: "order_id", type: { kind: "uuid" }, nullable: false },
              { name: "quantity", type: { kind: "int" }, nullable: false },
            ],
            primaryKey: ["id"],
            foreignKeys: [{ column: "order_id", refTable: "orders", onDelete: "cascade" }],
            indexes: [],
          },
        },
      ],
      version: "20260101000000",
      name: "Initial",
    };
    const files = emit(ir);
    // Two files — one per table — with parent (orders) before part (order_lines).
    // Parts are timestamped at BASE + parentCount*10 + parentIndex*10 + partIndex+1
    // = BASE + 1*10 + 0*10 + 1 = BASE + 11, preserving the legacy emitter's scheme.
    const paths = [...files.keys()].sort();
    expect(paths).toEqual([
      "priv/repo/migrations/20260101000000_create_orders.exs",
      "priv/repo/migrations/20260101000011_create_order_lines.exs",
    ]);
    const orderLines = files.get("priv/repo/migrations/20260101000011_create_order_lines.exs")!;
    // Cascade-delete FK lowers to references(..., on_delete: :delete_all).
    expect(orderLines).toMatch(
      /add :order_id, references\(:orders, type: :uuid, on_delete: :delete_all\), null: false/,
    );
  });

  it("orders parent tables FK-topologically so a cross-aggregate reference target is created first (B10)", () => {
    // Two PARENT aggregates: `gadgets` carries a cross-aggregate `X id` reference
    // (`widgetId: Widget id`) → an inline `references(:widgets)` FK (on_delete:
    // :restrict, NOT the cascade a part uses).  Alphabetically `gadgets` < `widgets`,
    // so the old alphabetical sort emitted `create_gadgets` FIRST — `ecto.migrate`
    // then hit `relation "<schema>.widgets" does not exist`.  The referenced table
    // must get the earlier timestamp.
    const ir: MigrationsIR = {
      module: "Catalog",
      storageName: "",
      baseline: null,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "createTable",
          table: {
            name: "gadgets",
            ownerModule: "Catalog",
            schema: "catalog",
            columns: [
              { name: "id", type: { kind: "uuid" }, nullable: false },
              { name: "widget_id", type: { kind: "uuid" }, nullable: false },
              { name: "label", type: { kind: "text" }, nullable: false },
            ],
            primaryKey: ["id"],
            foreignKeys: [{ column: "widget_id", refTable: "widgets", onDelete: "restrict" }],
            indexes: [],
          },
        },
        {
          op: "createTable",
          table: {
            name: "widgets",
            ownerModule: "Catalog",
            schema: "catalog",
            columns: [
              { name: "id", type: { kind: "uuid" }, nullable: false },
              { name: "name", type: { kind: "text" }, nullable: false },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
            indexes: [],
          },
        },
      ],
      version: "20260101000000",
      name: "Initial",
    };
    const files = emit(ir);
    const paths = [...files.keys()].sort();
    // widgets (the FK target) gets BASE + 0; gadgets (the referencer) BASE + 1.
    expect(paths).toEqual([
      "priv/repo/migrations/20260101000000_create_widgets.exs",
      "priv/repo/migrations/20260101000001_create_gadgets.exs",
    ]);
  });

  it("renders the per-context event-log table with a composite PK, the unique seq index, and no timestamps()", () => {
    // The `<ctx>_events` log (event-log-architecture.md) has no `id` (so it
    // would otherwise fall to the state-table renderer, which emits no indexes
    // and appends timestamps()).  It needs the composite (stream_type,
    // stream_id, version) PK, the bigserial `seq` cursor + its unique index,
    // and NO timestamps() — its time column is the explicit `occurred_at`.
    const ir: MigrationsIR = {
      module: "Ledger",
      storageName: "",
      baseline: null,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "createTable",
          table: {
            name: "accounts_events",
            ownerModule: "Ledger",
            columns: [
              { name: "seq", type: { kind: "bigserial" }, nullable: false },
              { name: "stream_type", type: { kind: "text" }, nullable: false },
              { name: "stream_id", type: { kind: "text" }, nullable: false },
              { name: "version", type: { kind: "int" }, nullable: false },
              { name: "type", type: { kind: "text" }, nullable: false },
              { name: "data", type: { kind: "json" }, nullable: false },
              {
                name: "occurred_at",
                type: { kind: "datetime" },
                nullable: false,
                default: "now()",
              },
            ],
            primaryKey: ["stream_type", "stream_id", "version"],
            foreignKeys: [],
            indexes: [
              {
                name: "accounts_events_seq_key",
                table: "accounts_events",
                columns: ["seq"],
                unique: true,
              },
            ],
          },
        },
      ],
      version: "20260101000000",
      name: "Initial",
    };
    const body = emit(ir).get("priv/repo/migrations/20260101000000_create_accounts_events.exs")!;
    // Composite PK — every key column marked primary_key: true.
    expect(body).toContain("add :stream_type, :string, primary_key: true, null: false");
    expect(body).toContain("add :stream_id, :string, primary_key: true, null: false");
    expect(body).toContain("add :version, :integer, primary_key: true, null: false");
    // The bigserial cursor is a plain column (not a PK).
    expect(body).toContain("add :seq, :bigserial, null: false");
    // occurred_at's SQL default is fragment-wrapped for Ecto DSL.
    expect(body).toContain(
      'add :occurred_at, :utc_datetime, null: false, default: fragment("now()")',
    );
    // The unique seq index carries its deterministic name.
    expect(body).toContain(
      'create index(:accounts_events, [:seq], unique: true, name: "accounts_events_seq_key")',
    );
    // No Ecto timestamps() — the log's time column is occurred_at.
    expect(body).not.toContain("timestamps()");
  });

  it("creates the Postgres schema and prefixes table / FK / index when the table is schema-qualified", () => {
    const ir: MigrationsIR = {
      module: "Catalog",
      storageName: "",
      baseline: null,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "createTable",
          table: {
            name: "projects",
            schema: "catalog",
            ownerModule: "Catalog",
            columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
            primaryKey: ["id"],
            foreignKeys: [],
            indexes: [],
          },
        },
        {
          op: "createTable",
          table: {
            name: "pipelines",
            schema: "catalog",
            ownerModule: "Catalog",
            columns: [
              { name: "id", type: { kind: "uuid" }, nullable: false },
              { name: "project_id", type: { kind: "uuid" }, nullable: false },
            ],
            primaryKey: ["id"],
            foreignKeys: [{ column: "project_id", refTable: "projects", onDelete: "cascade" }],
            indexes: [
              {
                name: "pipelines_project_id_idx",
                table: "pipelines",
                columns: ["project_id"],
                unique: false,
              },
            ],
          },
        },
      ],
      version: "20260101000000",
      name: "Initial",
    };
    const files = emit(ir);
    // The Ash resource maps `table "projects"` + `schema "catalog"`, so the
    // migration must create the schema and qualify every relation.
    const projects = files.get("priv/repo/migrations/20260101000000_create_projects.exs")!;
    expect(projects).toContain('execute "CREATE SCHEMA IF NOT EXISTS catalog"');
    expect(projects).toContain('create table(:projects, primary_key: false, prefix: "catalog")');
    // The part table's FK reference and index carry the prefix too.
    const pipelines = files.get("priv/repo/migrations/20260101000011_create_pipelines.exs")!;
    expect(pipelines).toContain('create table(:pipelines, primary_key: false, prefix: "catalog")');
    expect(pipelines).toMatch(/references\(:projects, prefix: "catalog", type: :uuid/);
    expect(pipelines).toContain('create index(:pipelines, [:project_id], prefix: "catalog")');
  });
});

describe("phoenix migrations-emit — SQL-expression column defaults", () => {
  // The shared MigrationsIR stores SQL defaults verbatim (`now()`,
  // `gen_random_uuid()` — the event-store table). Valid bare in raw Postgres
  // DDL (sql-pg.ts) but NOT in Ecto migration DSL: a bare `default: now()`
  // is an undefined-function compile error (`mix ecto.migrate` won't compile).
  // A SQL function call must be wrapped in `fragment("…")`; a plain literal
  // stays bare.
  it("wraps SQL-function defaults in fragment(...) and leaves literals bare", () => {
    const ir: MigrationsIR = {
      module: "Sales",
      storageName: "",
      baseline: null,
      next: EMPTY_SNAP,
      steps: [
        {
          op: "createTable",
          table: {
            name: "order_events",
            ownerModule: "Sales",
            columns: [
              { name: "id", type: { kind: "uuid" }, nullable: false },
              {
                name: "occurred_at",
                type: { kind: "datetime" },
                nullable: false,
                default: "now()",
              },
              {
                name: "token",
                type: { kind: "uuid" },
                nullable: false,
                default: "gen_random_uuid()",
              },
              { name: "attempts", type: { kind: "int" }, nullable: false, default: "0" },
            ],
            primaryKey: ["id"],
            foreignKeys: [],
            indexes: [],
          },
        },
      ],
      version: "20260101000000",
      name: "Initial",
    };
    const out = new Map<string, string>();
    emitMigrations("phoenix_app", [ir], APP_MODULE, out);
    const body = [...out.values()].join("\n");
    expect(body).toContain('default: fragment("now()")');
    expect(body).toContain('default: fragment("gen_random_uuid()")');
    // A bare SQL-function default is the compile-error bug — must NOT appear.
    expect(body).not.toMatch(/default: now\(\)/);
    expect(body).not.toMatch(/default: gen_random_uuid\(\)/);
    // Numeric literal stays bare (no fragment).
    expect(body).toContain("default: 0");
    expect(body).not.toContain('fragment("0")');
  });
});

describe("phoenix migrations-emit — multi-module initial versions are unique", () => {
  // A backend that serves >1 module writes all their initial migrations into
  // ONE priv/repo/migrations/ dir.  Each module's versions are allocated from
  // BASE_TIMESTAMP, so without a per-module offset every module's first table
  // collides at 20260101000000 — and Ecto refuses to run a dir with a
  // duplicated version (`migration version ... is duplicated`), crashing the
  // release migrate-on-boot.  This pins that each module's block is offset.
  const initialModule = (module: string, table: string): MigrationsIR => ({
    module,
    storageName: "",
    baseline: null,
    next: EMPTY_SNAP,
    steps: [
      {
        op: "createTable",
        table: {
          name: table,
          ownerModule: module,
          columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
          primaryKey: ["id"],
          foreignKeys: [],
          indexes: [],
        },
      },
    ],
    version: "20260101000000",
    name: "Initial",
  });

  it("offsets each module so no two migration files share a version prefix", () => {
    const out = new Map<string, string>();
    emitMigrations(
      "phoenix_app",
      [
        initialModule("Catalog", "projects"),
        initialModule("Builds", "builds"),
        initialModule("People", "engineers"),
      ],
      APP_MODULE,
      out,
    );
    const versions = [...out.keys()].map((p) => p.match(/migrations\/(\d+)_/)![1]!);
    expect(versions).toHaveLength(3);
    // All distinct — the bug emitted three files all at 20260101000000.
    expect(new Set(versions).size).toBe(3);
  });
});
