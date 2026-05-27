import { describe, expect, it } from "vitest";

import { emitMigrations } from "../../../src/generator/phoenix-live-view/migrations-emit.js";
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
});
