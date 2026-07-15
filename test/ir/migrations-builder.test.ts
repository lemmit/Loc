import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderPgStep } from "../../src/generator/sql-pg.js";
import type {
  ColumnShape,
  MigrationStep,
  SchemaSnapshot,
  TableShape,
} from "../../src/ir/types/migrations-ir.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import {
  applyDestructivePolicy,
  BASE_TIMESTAMP,
  buildMigrations,
  diffSchema,
  MigrationDestructiveError,
  schemaFromModule,
} from "../../src/system/migrations-builder.js";
import {
  fsSnapshotStore,
  memorySnapshotStore,
  SnapshotReadError,
  serializeSnapshot,
  snapshotRelPath,
} from "../../src/system/snapshot.js";
import { buildLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// migrations-builder — schemaFromModule + diffSchema + buildMigrations.
//
// Tests pin three contracts:
//   1. Tables come out in alphabetical order, columns in declaration order.
//   2. Same snapshot in/out ⇒ no steps (regenerating a clean repo is a no-op).
//   3. Owner enrichment picks the explicit primary binding first, falls
//      back to the first needsDb deployable that includes the module.
// ---------------------------------------------------------------------------

const SHOP_SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        customer: Customer id
        total: int
        contains lines: OrderLine[]
        entity OrderLine { quantity: int }
      }
      aggregate Customer {
        name: string
      }
      repository Orders for Order { }
      repository Customers for Customer { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
`;

async function loadShop() {
  const loom = await buildLoomModel(SHOP_SOURCE);
  const sys = loom.systems[0]!;
  const module = sys.subdomains[0]!;
  return { loom, sys, module };
}

describe("schemaFromModule", () => {
  it("emits one table per aggregate plus one per part, sorted by name", async () => {
    const { module } = await loadShop();
    const snap = schemaFromModule(module);
    expect(snap.tables.map((t) => t.name)).toEqual(["customers", "order_lines", "orders"]);
  });

  it("places id first, then declared fields in source order", async () => {
    const { module } = await loadShop();
    const orders = schemaFromModule(module).tables.find((t) => t.name === "orders")!;
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "customer", "total", "version"]);
    expect(orders.primaryKey).toEqual(["id"]);
  });

  it("emits a persisted state table for a correlation-bearing workflow", async () => {
    const loom = await buildLoomModel(`
      system Saga {
        subdomain S {
          context C {
            aggregate Order { total: int }
            repository Orders for Order { }
            event OrderPlaced { order: Order id, at: datetime }
            channel L { carries: OrderPlaced  delivery: broadcast  retention: ephemeral }
            workflow Fulfillment {
              orderId: Order id
              attempts: int
              on(p: OrderPlaced) by p.order { }
            }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
      }`);
    const snap = schemaFromModule(loom.systems[0]!.subdomains[0]!);
    const wf = snap.tables.find((t) => t.name === "fulfillments");
    expect(wf, "fulfillments workflow-state table").toBeDefined();
    // PK = the correlation field; saga state field follows.
    expect(wf?.primaryKey).toEqual(["order_id"]);
    expect(wf?.columns.map((c) => c.name)).toEqual(["order_id", "attempts"]);
    // Standalone routing record — no FK back to the orders table.
    expect(wf?.foreignKeys).toEqual([]);
  });

  it("emits no workflow-state table for a workflow without a correlation field", async () => {
    const { module } = await loadShop();
    // Shop has no workflows at all → no workflow-state tables.
    const snap = schemaFromModule(module);
    expect(snap.tables.every((t) => ["customers", "order_lines", "orders"].includes(t.name))).toBe(
      true,
    );
  });

  it("maps the `money` primitive to a decimal column (precise-decimal family)", async () => {
    // Regression: a system whose aggregate carries a `money` field used to
    // throw "unknown primitive type 'money'" out of the migrations builder
    // (the money-primitive fixture only exercised the legacy single-context
    // path, never system migration derivation).  money is a precise decimal,
    // so it rides the same column kind as `decimal`.
    const loom = await buildLoomModel(`
      system Billing {
        subdomain Money {
          context Money {
            aggregate Invoice { subtotal: money }
            repository Invoices for Invoice { }
          }
        }
        deployable api { platform: node, contexts: [Money], port: 3000 }
      }
    `);
    const snap = schemaFromModule(loom.systems[0]!.subdomains[0]!);
    const invoice = snap.tables.find((t) => t.name === "invoices")!;
    const subtotal = invoice.columns.find((c) => c.name === "subtotal")!;
    expect(subtotal.type).toEqual({ kind: "decimal" });
  });

  it("emits a uuid FK column + per-column index for `Target id` references", async () => {
    const { module } = await loadShop();
    const orders = schemaFromModule(module).tables.find((t) => t.name === "orders")!;
    const customer = orders.columns.find((c) => c.name === "customer")!;
    expect(customer.type).toEqual({ kind: "uuid" });
    expect(customer.nullable).toBe(false);
    expect(orders.foreignKeys).toEqual([
      { column: "customer", refTable: "customers", onDelete: "restrict" },
    ]);
    expect(orders.indexes).toEqual([
      { name: "orders_customer_idx", table: "orders", columns: ["customer"], unique: false },
    ]);
  });

  it("emits part tables with a parent FK and cascade delete", async () => {
    const { module } = await loadShop();
    const lines = schemaFromModule(module).tables.find((t) => t.name === "order_lines")!;
    expect(lines.columns.map((c) => c.name)).toEqual(["id", "order_id", "quantity"]);
    expect(lines.foreignKeys).toEqual([
      { column: "order_id", refTable: "orders", onDelete: "cascade" },
    ]);
    // Cascade FKs always get a covering index so the cascade probe is
    // index-driven, not seq-scan-driven.
    expect(lines.indexes.map((i) => i.name)).toContain("order_lines_order_id_idx");
  });

  it("is deterministic across invocations", async () => {
    const { module } = await loadShop();
    const a = JSON.stringify(schemaFromModule(module));
    const b = JSON.stringify(schemaFromModule(module));
    expect(a).toBe(b);
  });
});

describe("diffSchema", () => {
  it("emits createTable for every table when baseline is null", async () => {
    const { module } = await loadShop();
    const snap = schemaFromModule(module);
    const steps = diffSchema(null, snap);
    expect(steps).toHaveLength(snap.tables.length);
    expect(steps.every((s) => s.op === "createTable")).toBe(true);
  });

  it("is empty when next equals prev", async () => {
    const { module } = await loadShop();
    const snap = schemaFromModule(module);
    expect(diffSchema(snap, snap)).toEqual([]);
  });

  it("orders createTable so an FK target precedes the table referencing it", () => {
    // `pipelines` FK-references `projects` but sorts alphabetically
    // first; the inline `REFERENCES projects` would fail if pipelines
    // were created first.  diffSchema must emit projects before pipelines.
    const snap: SchemaSnapshot = {
      schemaVersion: 1,
      tables: [
        {
          name: "pipelines",
          ownerModule: "Catalog",
          columns: [
            { name: "id", type: { kind: "uuid" }, nullable: false },
            { name: "project_id", type: { kind: "uuid" }, nullable: false },
          ],
          primaryKey: ["id"],
          foreignKeys: [{ column: "project_id", refTable: "projects", onDelete: "cascade" }],
          indexes: [],
        },
        {
          name: "projects",
          ownerModule: "Catalog",
          columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
          primaryKey: ["id"],
          foreignKeys: [],
          indexes: [],
        },
      ],
    };
    const created = diffSchema(null, snap)
      .filter((s) => s.op === "createTable")
      .map((s) => (s.op === "createTable" ? s.table.name : ""));
    expect(created).toEqual(["projects", "pipelines"]);
  });

  it("emits dropTable for tables only in prev", async () => {
    const { module } = await loadShop();
    const next = schemaFromModule(module);
    const prev: SchemaSnapshot = {
      ...next,
      tables: [
        ...next.tables,
        {
          name: "stale",
          ownerModule: "Sales",
          columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
          primaryKey: ["id"],
          foreignKeys: [],
          indexes: [],
        },
      ],
    };
    const steps = diffSchema(prev, next);
    expect(steps).toEqual([{ op: "dropTable", name: "stale" }]);
  });

  it("emits addColumn for new columns on a matched table", async () => {
    const { module } = await loadShop();
    const next = schemaFromModule(module);
    const prev = withModifiedTable(next, "orders", (t) => ({
      ...t,
      columns: t.columns.filter((c) => c.name !== "total"),
    }));
    const steps = diffSchema(prev, next);
    expect(steps).toEqual([
      {
        op: "addColumn",
        table: "orders",
        column: { name: "total", type: { kind: "int" }, nullable: false },
      },
    ]);
  });

  it("emits dropColumn for columns only in prev", async () => {
    const { module } = await loadShop();
    const next = schemaFromModule(module);
    const prev = withModifiedTable(next, "orders", (t) => ({
      ...t,
      columns: [...t.columns, { name: "legacy_note", type: { kind: "text" }, nullable: true }],
    }));
    const steps = diffSchema(prev, next);
    expect(steps).toEqual([{ op: "dropColumn", table: "orders", name: "legacy_note" }]);
  });

  it("emits alterColumnNullable on a nullability flip", async () => {
    const { module } = await loadShop();
    const next = schemaFromModule(module);
    const prev = withModifiedTable(next, "orders", (t) => ({
      ...t,
      columns: t.columns.map((c) => (c.name === "total" ? { ...c, nullable: true } : c)),
    }));
    const steps = diffSchema(prev, next);
    expect(steps).toEqual([
      {
        op: "alterColumnNullable",
        table: "orders",
        name: "total",
        type: { kind: "int" },
        nullable: false,
      },
    ]);
  });

  it("emits alterColumnType on a type change", async () => {
    const { module } = await loadShop();
    const next = schemaFromModule(module);
    const prev = withModifiedTable(next, "orders", (t) => ({
      ...t,
      columns: t.columns.map((c) =>
        c.name === "total" ? { ...c, type: { kind: "bigint" as const } } : c,
      ),
    }));
    const steps = diffSchema(prev, next);
    expect(steps).toEqual([
      {
        op: "alterColumnType",
        table: "orders",
        name: "total",
        from: { kind: "bigint" },
        to: { kind: "int" },
      },
    ]);
  });

  it("detects index additions and removals by name", async () => {
    const { module } = await loadShop();
    const next = schemaFromModule(module);
    const prev = withModifiedTable(next, "orders", (t) => ({
      ...t,
      indexes: [],
    }));
    const stepsAdd = diffSchema(prev, next);
    expect(stepsAdd.some((s) => s.op === "addIndex")).toBe(true);

    const stepsDrop = diffSchema(next, prev);
    expect(stepsDrop.some((s) => s.op === "dropIndex")).toBe(true);
  });
});

describe("diffSchema — explicit renames (M-T2.1)", () => {
  // Minimal single-table snapshots (no FK/index noise) so the assertions
  // isolate the rename pass.  Renames are a flat list keyed by table name;
  // diffSchema indexes them internally (no schema here → public).
  const col = (name: string, kind = "int", nullable = false): ColumnShape => ({
    name,
    type: { kind } as ColumnShape["type"],
    nullable,
  });
  const snap = (columns: ColumnShape[]): SchemaSnapshot => ({
    schemaVersion: 1,
    tables: [
      {
        name: "orders",
        ownerModule: "Sales",
        columns,
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [],
      },
    ],
  });

  it("collapses TWO simultaneous renames into two renameColumn + zero drops", () => {
    const prev = snap([col("id", "uuid"), col("qty"), col("shipped_at", "datetime")]);
    const next = snap([col("id", "uuid"), col("quantity"), col("fulfilled_at", "datetime")]);
    const steps = diffSchema(prev, next, [
      { table: "orders", from: "qty", to: "quantity" },
      { table: "orders", from: "shipped_at", to: "fulfilled_at" },
    ]);
    expect(steps.filter((s) => s.op === "renameColumn")).toEqual([
      {
        op: "renameColumn",
        table: "orders",
        schema: undefined,
        from: "qty",
        to: "quantity",
        type: { kind: "int" },
      },
      {
        op: "renameColumn",
        table: "orders",
        schema: undefined,
        from: "shipped_at",
        to: "fulfilled_at",
        type: { kind: "datetime" },
      },
    ]);
    expect(steps.some((s) => s.op === "dropColumn" || s.op === "addColumn")).toBe(false);
  });

  it("emits renameColumn + alterColumnType for a rename that also changes type", () => {
    const prev = snap([col("id", "uuid"), col("qty", "int")]);
    const next = snap([col("id", "uuid"), col("quantity", "bigint")]);
    const steps = diffSchema(prev, next, [{ table: "orders", from: "qty", to: "quantity" }]);
    expect(steps).toEqual([
      {
        op: "renameColumn",
        table: "orders",
        schema: undefined,
        from: "qty",
        to: "quantity",
        type: { kind: "bigint" },
      },
      {
        op: "alterColumnType",
        table: "orders",
        schema: undefined,
        name: "quantity",
        from: { kind: "int" },
        to: { kind: "bigint" },
      },
    ]);
  });

  it("resolves a chained rename (qty -> quantity -> amount) to one renameColumn", () => {
    const prev = snap([col("id", "uuid"), col("qty")]);
    const next = snap([col("id", "uuid"), col("amount")]);
    const steps = diffSchema(prev, next, [
      { table: "orders", from: "qty", to: "quantity" },
      { table: "orders", from: "quantity", to: "amount" },
    ]);
    expect(steps).toEqual([
      {
        op: "renameColumn",
        table: "orders",
        schema: undefined,
        from: "qty",
        to: "amount",
        type: { kind: "int" },
      },
    ]);
  });

  it("WITHOUT a rename intent, two-at-once degrades to drop+add (the gap M-T2.1 closes)", () => {
    const prev = snap([col("id", "uuid"), col("qty"), col("shipped_at", "datetime")]);
    const next = snap([col("id", "uuid"), col("quantity"), col("fulfilled_at", "datetime")]);
    const steps = diffSchema(prev, next); // no renames
    expect(steps.some((s) => s.op === "renameColumn")).toBe(false);
    expect(steps.filter((s) => s.op === "dropColumn")).toHaveLength(2);
    expect(steps.filter((s) => s.op === "addColumn")).toHaveLength(2);
  });

  it("renders the rename+retype path to Postgres DDL in the right order", () => {
    const prev = snap([col("id", "uuid"), col("qty", "int")]);
    const next = snap([col("id", "uuid"), col("quantity", "bigint")]);
    const sql = diffSchema(prev, next, [{ table: "orders", from: "qty", to: "quantity" }]).map(
      renderPgStep,
    );
    expect(sql[0]).toBe('ALTER TABLE "orders" RENAME COLUMN "qty" TO "quantity";');
    expect(sql[1]).toMatch(/ALTER TABLE "orders" ALTER COLUMN "quantity" TYPE BIGINT/);
  });
});

describe("diffSchema — table renames (M-T2.1 aggregate/table rename)", () => {
  const tbl = (name: string): TableShape => ({
    name,
    ownerModule: "Sales",
    columns: [{ name: "id", type: { kind: "uuid" }, nullable: false }],
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
  });
  const snap = (tables: TableShape[]): SchemaSnapshot => ({ schemaVersion: 1, tables });

  it("emits a single renameTable and NO drop/create when a table is renamed", () => {
    const prev = snap([tbl("orders")]);
    const next = snap([tbl("purchase_orders")]);
    const steps = diffSchema(prev, next, [], [{ from: "orders", to: "purchase_orders" }]);
    expect(steps).toEqual([
      { op: "renameTable", from: "orders", to: "purchase_orders", schema: undefined },
    ]);
    // Without the intent, the same delta is the data-losing drop+create.
    const naive = diffSchema(prev, next);
    expect(naive.some((s) => s.op === "dropTable")).toBe(true);
    expect(naive.some((s) => s.op === "createTable")).toBe(true);
  });

  it("is a no-op when the old table is absent from the baseline (ledger idempotency)", () => {
    // Baseline already carries the NEW name — the rename was baked in earlier.
    const baked = snap([tbl("purchase_orders")]);
    const steps = diffSchema(baked, baked, [], [{ from: "orders", to: "purchase_orders" }]);
    expect(steps).toEqual([]);
  });

  it("skips a rename whose target name already exists (collision guard)", () => {
    const prev = snap([tbl("orders"), tbl("purchase_orders")]);
    const next = snap([tbl("orders"), tbl("purchase_orders")]);
    const steps = diffSchema(prev, next, [], [{ from: "orders", to: "purchase_orders" }]);
    expect(steps.some((s) => s.op === "renameTable")).toBe(false);
  });

  it("renders renameTable to Postgres DDL (schema-qualified source, bare target)", () => {
    const withSchema = (name: string): TableShape => ({ ...tbl(name), schema: "sales" });
    const steps = diffSchema(
      snap([withSchema("orders")]),
      snap([withSchema("purchase_orders")]),
      [],
      [{ from: "orders", to: "purchase_orders", schema: "sales" }],
    );
    expect(steps.map(renderPgStep)).toEqual([
      'ALTER TABLE "sales"."orders" RENAME TO "purchase_orders";',
    ]);
  });
});

describe("buildMigrations — table/aggregate rename intent (M-T2.1)", () => {
  // Same aggregate under its OLD and NEW name; the OLD build supplies the
  // baseline snapshot (so the on-disk names are exactly what the schema emitter
  // produced), the NEW build carries the `migration` block.
  const SRC = (aggName: string) => `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate ${aggName} {
        total: int
        tags: Tag id[]
        charges: Money[]
        contains lines: Line[]
        entity Line { sku: string }
      }
      aggregate Tag { label: string }
      valueobject Money {
        amount: int
        currency: string
      }
      repository Orders for ${aggName} { }
      repository Tags for Tag { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}`;

  const buildBaselineAndNext = async () => {
    const oldLoom = await buildLoomModel(SRC("Order"));
    const baseline: SchemaSnapshot = {
      ...schemaFromModule(oldLoom.systems[0]!.subdomains[0]!),
      lastVersion: BASE_TIMESTAMP,
    };
    const newLoom = await buildLoomModel(
      `${SRC("PurchaseOrder")}\nmigration "rename-order" { Order -> PurchaseOrder }`,
    );
    return { baseline, newLoom };
  };

  it("renames the root table + owned child tables and their FK columns — no data-losing drop", async () => {
    const { baseline, newLoom } = await buildBaselineAndNext();
    const out = buildMigrations(newLoom.systems[0]!, memorySnapshotStore({ Sales: baseline }), {
      tableRenameIntents: newLoom.tableRenameIntents,
    });
    const steps = out[0]!.steps;
    const renamedTables = steps
      .filter((s): s is Extract<MigrationStep, { op: "renameTable" }> => s.op === "renameTable")
      .map((s) => `${s.from}->${s.to}`)
      .sort();
    expect(renamedTables).toEqual([
      "order_charges->purchase_order_charges", // value-object collection child
      "order_tags->purchase_order_tags", // association join table
      "orders->purchase_orders", // aggregate root
    ]);
    // The owner FK column on every owned table moves `order_id -> purchase_order_id`.
    const fkRenames = steps
      .filter(
        (s): s is Extract<MigrationStep, { op: "renameColumn" }> =>
          s.op === "renameColumn" && s.from === "order_id" && s.to === "purchase_order_id",
      )
      .map((s) => s.table)
      .sort();
    expect(fkRenames).toEqual(["lines", "purchase_order_charges", "purchase_order_tags"]);
    // The whole point: the rename is NON-destructive — no dropped/created table
    // or dropped column smuggles data loss past the gate.
    expect(steps.some((s) => s.op === "dropTable" || s.op === "createTable")).toBe(false);
    expect(steps.some((s) => s.op === "dropColumn")).toBe(false);
  });

  it("is inert once the rename is baked into the baseline (ledger idempotency)", async () => {
    const { newLoom } = await buildBaselineAndNext();
    // Baseline already reflects the NEW aggregate name.
    const baked: SchemaSnapshot = {
      ...schemaFromModule(newLoom.systems[0]!.subdomains[0]!),
      lastVersion: BASE_TIMESTAMP,
    };
    const out = buildMigrations(newLoom.systems[0]!, memorySnapshotStore({ Sales: baked }), {
      tableRenameIntents: newLoom.tableRenameIntents,
    });
    expect(out[0]!.steps).toEqual([]);
  });
});

describe("buildMigrations — migration-block rename intent (M-T2.1)", () => {
  const RENAME_SRC = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order { quantity: int }
      repository Orders for Order { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
migration "rename-qty" { Order.qty -> quantity }
`;

  it("emits an explicit renameColumn (no drop) when a migration block renames a field", async () => {
    const loom = await buildLoomModel(RENAME_SRC);
    const sys = loom.systems[0]!;
    // Baseline still carries the OLD column name `qty`.
    const next = schemaFromModule(sys.subdomains[0]!);
    const baseline = withModifiedTable({ ...next, lastVersion: BASE_TIMESTAMP }, "orders", (t) => ({
      ...t,
      columns: t.columns.map((c) => (c.name === "quantity" ? { ...c, name: "qty" } : c)),
    }));
    const out = buildMigrations(sys, memorySnapshotStore({ Sales: baseline }), {
      renameIntents: loom.renameIntents,
    });
    const steps = out[0]!.steps;
    expect(
      steps.some((s) => s.op === "renameColumn" && s.from === "qty" && s.to === "quantity"),
    ).toBe(true);
    expect(steps.some((s) => s.op === "dropColumn")).toBe(false);
    expect(steps.some((s) => s.op === "addColumn")).toBe(false);
  });

  it("is inert once the rename is baked into the baseline (ledger idempotency)", async () => {
    const loom = await buildLoomModel(RENAME_SRC);
    const sys = loom.systems[0]!;
    // Baseline already has the NEW name — the ledger block must be a no-op now.
    const baseline: SchemaSnapshot = {
      ...schemaFromModule(sys.subdomains[0]!),
      lastVersion: BASE_TIMESTAMP,
    };
    const out = buildMigrations(sys, memorySnapshotStore({ Sales: baseline }), {
      renameIntents: loom.renameIntents,
    });
    expect(out[0]!.steps).toEqual([]);
  });
});

describe("buildMigrations", () => {
  it("returns one entry per owned module, with the right version + name on initial run", async () => {
    const { sys } = await loadShop();
    const out = buildMigrations(sys, memorySnapshotStore());
    expect(out).toHaveLength(1);
    expect(out[0]!.module).toBe("Sales");
    expect(out[0]!.version).toBe(BASE_TIMESTAMP);
    expect(out[0]!.name).toBe("Initial");
    expect(out[0]!.steps.length).toBeGreaterThan(0);
    expect(out[0]!.next.lastVersion).toBe(BASE_TIMESTAMP);
  });

  it("returns empty steps + carried-over lastVersion when snapshot already matches", async () => {
    const { sys, module } = await loadShop();
    const snap = schemaFromModule(module);
    const baseline: SchemaSnapshot = { ...snap, lastVersion: BASE_TIMESTAMP };
    const out = buildMigrations(sys, memorySnapshotStore({ Sales: baseline }));
    expect(out).toHaveLength(1);
    expect(out[0]!.steps).toEqual([]);
    expect(out[0]!.next.lastVersion).toBe(BASE_TIMESTAMP);
  });

  it("bumps lastVersion by 1 when the snapshot differs", async () => {
    const { sys, module } = await loadShop();
    const next = schemaFromModule(module);
    const stale = withModifiedTable(next, "orders", (t) => ({
      ...t,
      columns: t.columns.filter((c) => c.name !== "total"),
    }));
    const baseline: SchemaSnapshot = { ...stale, lastVersion: BASE_TIMESTAMP };
    // Re-adding the non-optional `total` column is a NOT-NULL add on a
    // pre-existing table → destructive; allow it so this test exercises only
    // the version-bump behaviour.
    const out = buildMigrations(sys, memorySnapshotStore({ Sales: baseline }), {
      allowDestructive: true,
    });
    expect(out[0]!.version).toBe(String(BigInt(BASE_TIMESTAMP) + 1n));
    expect(out[0]!.next.lastVersion).toBe(out[0]!.version);
    expect(out[0]!.name).not.toBe("Initial");
  });

  it("skips modules with no migrationsOwner", async () => {
    // Two modules, only one is reachable from a needsDb deployable.
    const loom = await buildLoomModel(`
system Twin {
  subdomain A { context Ca { aggregate X { n: int } } }
  subdomain B { context Cb { aggregate Y { n: int } } }
  deployable api { platform: node, contexts: [Ca], port: 3000 }
}
`);
    const out = buildMigrations(loom.systems[0]!, memorySnapshotStore());
    expect(out.map((m) => m.module)).toEqual(["A"]);
  });
});

describe("buildMigrations — workflow saga tables land in the context schema", () => {
  // A workflow is context-owned, so its saga tables (correlation-state row +
  // event-log stream) belong in the owning context's schema — beside its
  // aggregate tables — not `public`, where two contexts with a same-named
  // workflow would collide.  Regression for the `archival_tracker_events`
  // escape (generated-code-ddd-review-2026-07 P2).
  // End-to-end via `buildMigrations` so the real resolver wiring (aggregate
  // `schemaOf` + the new context `contextSchemaOf`) is exercised together.
  async function sagaSchemas(src: string) {
    const loom = await buildLoomModel(src);
    const out = buildMigrations(loom.systems[0]!, memorySnapshotStore());
    return out[0]!.next.tables;
  }

  // A context body with an event-sourced (`_events`) and a correlation-state
  // (`tallies`) saga workflow; `BIND` sets the state resource (or nothing).
  const src = (bind: string) => `system S { subdomain M { context Ord {
  aggregate Order { status: string  operation place() { status := "P"  emit OrderPlaced { order: id } } }
  repository Orders for Order { }
  event OrderPlaced { order: Order id }
  event PaymentRegistered { order: Order id, amount: int }
  workflow Tally eventSourced {
    orderId: Order id
    total: int
    create(p: OrderPlaced) by p.order { emit PaymentRegistered { order: p.order, amount: 0 } }
    apply(pr: PaymentRegistered) { total := total + pr.amount }
  }
  workflow Ledger {
    orderId: Order id
    seen: int
    create(p: OrderPlaced) by p.order { }
  }
} } api A from M storage pg { type: postgres }
  ${bind}
  deployable api { platform: node contexts: [Ord] serves: A ${bind ? "dataSources: [ordState] " : ""}port: 3000 } }`;

  it("stamps the context schema on both saga tables (default snake(ctx))", async () => {
    const tables = await sagaSchemas(src("resource ordState { for: Ord, kind: state, use: pg }"));
    // The ES workflow's stream now lives in the single per-context event log
    // `<ctx>_events` (event-log-architecture.md), not a per-workflow table.
    const stream = tables.find((t) => t.name === "ord_events")!;
    const state = tables.find((t) => t.name === "ledgers")!;
    const orders = tables.find((t) => t.name === "orders")!;
    // Saga tables share the context's aggregate schema (default `snake(ctx)`).
    expect(orders.schema).toBe("ord");
    expect(stream.schema).toBe("ord");
    expect(state.schema).toBe("ord");
  });

  it("honours an explicit `schema:` override for the saga tables", async () => {
    const tables = await sagaSchemas(
      src('resource ordState { for: Ord, kind: state, use: pg, schema: "sales" }'),
    );
    expect(tables.find((t) => t.name === "ord_events")?.schema).toBe("sales");
    expect(tables.find((t) => t.name === "ledgers")?.schema).toBe("sales");
  });

  it("leaves saga tables unqualified when the context has no resource binding", async () => {
    const tables = await sagaSchemas(src(""));
    // No binding → byte-identical unqualified output (public), like aggregates.
    expect(tables.find((t) => t.name === "tally_events")?.schema).toBeUndefined();
    expect(tables.find((t) => t.name === "ledgers")?.schema).toBeUndefined();
    expect(tables.find((t) => t.name === "orders")?.schema).toBeUndefined();
  });
});

describe("fsSnapshotStore", () => {
  const tmpDirs: string[] = [];
  const mkTmp = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-snap-"));
    tmpDirs.push(dir);
    return dir;
  };
  const writeSnapshot = (root: string, module: string, contents: string): string => {
    const filePath = path.join(root, snapshotRelPath(module));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
    return filePath;
  };

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no snapshot file exists (first run)", () => {
    const root = mkTmp();
    expect(fsSnapshotStore(root).read("Sales")).toBeNull();
  });

  it("reads back a well-formed snapshot", async () => {
    const { module } = await loadShop();
    const snap: SchemaSnapshot = { ...schemaFromModule(module), lastVersion: BASE_TIMESTAMP };
    const root = mkTmp();
    writeSnapshot(root, "Sales", serializeSnapshot(snap));
    const read = fsSnapshotStore(root).read("Sales");
    expect(read?.lastVersion).toBe(BASE_TIMESTAMP);
    expect(read?.tables.map((t) => t.name)).toEqual(snap.tables.map((t) => t.name));
  });

  it("throws SnapshotReadError naming the file when the snapshot is corrupt", () => {
    const root = mkTmp();
    const filePath = writeSnapshot(root, "Sales", '{"tables": [ {"name": "orders"'); // truncated
    expect(() => fsSnapshotStore(root).read("Sales")).toThrow(SnapshotReadError);
    try {
      fsSnapshotStore(root).read("Sales");
      expect.unreachable("expected a SnapshotReadError");
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotReadError);
      const e = err as SnapshotReadError;
      expect(e.filePath).toBe(filePath);
      expect(e.message).toContain(filePath);
      expect(e.message).toMatch(/corrupt|truncat/i);
      expect(e.message).toMatch(/restore it from version control|re-baseline/i);
    }
  });
});

describe("buildMigrations — corrupt snapshot never re-baselines", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws instead of emitting an Initial migration for a corrupt snapshot", async () => {
    const { sys } = await loadShop();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-snap-"));
    tmpDirs.push(root);
    const filePath = path.join(root, snapshotRelPath("Sales"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "}}} not json {{{"); // corrupted (e.g. interrupted write)

    // Must NOT be interpreted as a fresh output dir → NO "Initial" migration.
    expect(() => buildMigrations(sys, fsSnapshotStore(root))).toThrow(SnapshotReadError);
    expect(() => buildMigrations(sys, fsSnapshotStore(root))).toThrow(filePath);
  });
});

describe("migrationsOwner enrichment", () => {
  it("uses the first needsDb deployable for bare modules-list deployables", async () => {
    const { sys } = await loadShop();
    expect(sys.subdomains[0]!.migrationsOwner).toBe("api");
  });

  it("D-STORAGE-SPLIT: migrationsOwner picks the first needsDb deployable hosting the subdomain's contexts", async () => {
    const loom = await buildLoomModel(`
system S {
  subdomain M { context C { aggregate X { n: int } } }
  storage pg { type: postgres }
  deployable first { platform: node, contexts: [C], port: 3000 }
  deployable second { platform: dotnet, contexts: [C], port: 3001 }
}
`);
    // Both deployables host C and both needsDb; declaration order wins.
    expect(loom.systems[0]!.subdomains[0]!.migrationsOwner).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withModifiedTable(
  snap: SchemaSnapshot,
  tableName: string,
  fn: (t: SchemaSnapshot["tables"][number]) => SchemaSnapshot["tables"][number],
): SchemaSnapshot {
  return {
    ...snap,
    tables: snap.tables.map((t) => (t.name === tableName ? fn(t) : t)),
  };
}

// ---------------------------------------------------------------------------
// Document shape (D-DOCUMENT-AXIS, shape(document)) — a document
// aggregate collapses to one `(id, data jsonb, version)` table; its parts
// fold into `data` (no part table) and reference collections become id
// arrays in `data` (no join table).
// ---------------------------------------------------------------------------

const DOC_SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Cart shape(document) {
        customer: Customer id
        total: int
        contains lines: CartLine[]
        entity CartLine { quantity: int }
      }
      aggregate Customer { name: string }
      repository Carts for Cart { }
      repository Customers for Customer { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
`;

describe("schemaFromModule — document shape", () => {
  async function loadDoc() {
    const loom = await buildLoomModel(DOC_SOURCE);
    return loom.systems[0]!.subdomains[0]!;
  }

  it("collapses a shape(document) aggregate to (id, data, version) with no part table", async () => {
    const module = await loadDoc();
    const snap = schemaFromModule(module);
    // Cart is a document → one `carts` table, no `cart_lines` part table.
    // Customer stays relational.
    expect(snap.tables.map((t) => t.name)).toEqual(["carts", "customers"]);
    const carts = snap.tables.find((t) => t.name === "carts")!;
    expect(carts.columns.map((c) => c.name)).toEqual(["id", "data", "version"]);
    expect(carts.columns.find((c) => c.name === "data")!.type).toEqual({ kind: "json" });
    expect(carts.columns.find((c) => c.name === "version")!.type).toEqual({ kind: "int" });
    expect(carts.primaryKey).toEqual(["id"]);
    // No FK to customers — the `Customer id` reference rides inside `data`.
    expect(carts.foreignKeys).toEqual([]);
    expect(carts.indexes).toEqual([]);
  });

  it("leaves relational siblings untouched", async () => {
    const module = await loadDoc();
    const customers = schemaFromModule(module).tables.find((t) => t.name === "customers")!;
    expect(customers.columns.map((c) => c.name)).toEqual(["id", "name", "version"]);
  });
});

describe("schemaFromModule — embedded shape", () => {
  const EMBEDDED_SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Cart shape(embedded) {
        customer: Customer id
        total: int
        contains lines: CartLine[]
        entity CartLine { quantity: int }
      }
      aggregate Customer { name: string }
      repository Carts for Cart { }
      repository Customers for Customer { }
    }
  }
  deployable api { platform: node, contexts: [Orders], port: 3000 }
}
`;

  it("keeps the queryable root + one JSONB column per containment, no part table", async () => {
    const loom = await buildLoomModel(EMBEDDED_SOURCE);
    const snap = schemaFromModule(loom.systems[0]!.subdomains[0]!);
    // Cart embeds → one `carts` table, no `cart_lines` part table.
    expect(snap.tables.map((t) => t.name)).toEqual(["carts", "customers"]);
    const carts = snap.tables.find((t) => t.name === "carts")!;
    // Root stays columns; the containment folds into a JSONB `lines` column.
    expect(carts.columns.map((c) => c.name)).toEqual([
      "id",
      "customer",
      "total",
      "version",
      "lines",
    ]);
    expect(carts.columns.find((c) => c.name === "lines")!.type).toEqual({ kind: "json" });
    expect(carts.columns.find((c) => c.name === "total")!.type).toEqual({ kind: "int" });
    // The `Customer id` reference stays a queryable FK column (unlike document).
    expect(carts.foreignKeys.map((fk) => fk.column)).toEqual(["customer"]);
  });
});

describe("buildMigrations — per-projection binding override", () => {
  it("honours a `resource shape: document` even when the aggregate header is shape(relational)", async () => {
    const loom = await buildLoomModel(`
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Cart shape(relational) { total: int }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  resource cartsState { for: Orders, kind: state, use: pg, shape: document }
  deployable api { platform: dotnet, contexts: [Orders], dataSources: [cartsState], port: 5000 }
}
`);
    const sys = loom.systems[0]!;
    const migs = buildMigrations(sys, memorySnapshotStore());
    const sales = migs.find((mi) => mi.module === "Sales")!;
    const carts = sales.next.tables.find((t) => t.name === "carts")!;
    // Binding override wins → document shape despite shape(relational) header.
    expect(carts.columns.map((c) => c.name)).toEqual(["id", "data", "version"]);
  });
});

// ---------------------------------------------------------------------------
// A8 hardening repros (audit findings 16–19): duplicate-table guard,
// schema-qualified deltas, FK-ordered drops, destructive-change gate.
// ---------------------------------------------------------------------------

/** Minimal one-column TableShape helper for hand-built diff snapshots. */
function tbl(
  name: string,
  columns: TableShape["columns"],
  extra: Partial<TableShape> = {},
): TableShape {
  return {
    name,
    ownerModule: "M",
    columns,
    primaryKey: ["id"],
    foreignKeys: [],
    indexes: [],
    ...extra,
  };
}

describe("A8.4 — duplicate-table guard", () => {
  it("errors when two same-named aggregates in sibling contexts map to one table", async () => {
    const loom = await buildLoomModel(`
system Shop {
  subdomain Commerce {
    context Sales {
      aggregate Order { total: int }
      repository SalesOrders for Order { }
    }
    context Billing {
      aggregate Order { amount: int }
      repository BillingOrders for Order { }
    }
  }
  deployable api { platform: node, contexts: [Sales, Billing], port: 3000 }
}
`);
    const diags = validateLoomModel(loom);
    const dup = diags.filter((d) => d.code === "loom.duplicate-table");
    expect(dup.length).toBeGreaterThan(0);
    expect(dup[0]!.message).toContain("public.orders");
  });

  it("accepts the same shape once each context has its own dataSource schema", async () => {
    const loom = await buildLoomModel(`
system Shop {
  subdomain Commerce {
    context Sales {
      aggregate Order { total: int }
      repository SalesOrders for Order { }
    }
    context Billing {
      aggregate Order { amount: int }
      repository BillingOrders for Order { }
    }
  }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg, schema: "sales" }
  resource billingState { for: Billing, kind: state, use: pg, schema: "billing" }
  deployable api {
    platform: node, contexts: [Sales, Billing],
    dataSources: [salesState, billingState], port: 3000
  }
}
`);
    const diags = validateLoomModel(loom);
    expect(diags.filter((d) => d.code === "loom.duplicate-table")).toEqual([]);
    // And the migration derives two correctly-qualified `orders` relations,
    // one per schema — the identity-based resolution (not name-only).
    const migs = buildMigrations(loom.systems[0]!, memorySnapshotStore());
    const commerce = migs.find((m) => m.module === "Commerce")!;
    const orders = commerce.next.tables.filter((t) => t.name === "orders");
    expect(orders.map((t) => t.schema).sort()).toEqual(["billing", "sales"]);
  });
});

describe("A8.1 — schema-qualified ALTER / DROP deltas", () => {
  it("carries the table schema onto alter/drop steps and renders it qualified", () => {
    const prev = {
      schemaVersion: 1 as const,
      tables: [
        tbl(
          "orders",
          [
            { name: "id", type: { kind: "uuid" as const }, nullable: false },
            { name: "total", type: { kind: "int" as const }, nullable: false },
            { name: "legacy", type: { kind: "text" as const }, nullable: true },
          ],
          { schema: "sales" },
        ),
      ],
    };
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl(
          "orders",
          [
            { name: "id", type: { kind: "uuid" as const }, nullable: false },
            // total flips to nullable → alterColumnNullable; legacy dropped.
            { name: "total", type: { kind: "int" as const }, nullable: true },
          ],
          { schema: "sales" },
        ),
      ],
    };
    const steps = diffSchema(prev, next);
    const drop = steps.find((s) => s.op === "dropColumn")!;
    const alter = steps.find((s) => s.op === "alterColumnNullable")!;
    expect(drop).toMatchObject({ schema: "sales", table: "orders", name: "legacy" });
    expect(alter).toMatchObject({ schema: "sales", table: "orders", name: "total" });
    expect(renderPgStep(drop)).toBe('ALTER TABLE "sales"."orders" DROP COLUMN "legacy";');
    expect(renderPgStep(alter)).toBe(
      'ALTER TABLE "sales"."orders" ALTER COLUMN "total" DROP NOT NULL;',
    );
  });

  it("reads an old unqualified snapshot as the same (now-qualified) table, not drop+create", () => {
    // Baseline written before schema-qualification (no `schema` field); the
    // current source resolves it into `sales`.  The diff must reconcile them
    // as one table (a column add), NOT drop `public.orders` + create
    // `sales.orders`.
    const prev = {
      schemaVersion: 1 as const,
      tables: [tbl("orders", [{ name: "id", type: { kind: "uuid" as const }, nullable: false }])],
    };
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl(
          "orders",
          [
            { name: "id", type: { kind: "uuid" as const }, nullable: false },
            { name: "note", type: { kind: "text" as const }, nullable: true },
          ],
          { schema: "sales" },
        ),
      ],
    };
    const steps = diffSchema(prev, next);
    expect(steps.some((s) => s.op === "dropTable")).toBe(false);
    expect(steps.some((s) => s.op === "createTable")).toBe(false);
    expect(steps.filter((s) => s.op === "addColumn")).toHaveLength(1);
  });
});

describe("A8.2 — FK-ordered drops", () => {
  it("drops a child table before the parent it FK-references", () => {
    const prev = {
      schemaVersion: 1 as const,
      tables: [
        tbl("orders", [{ name: "id", type: { kind: "uuid" as const }, nullable: false }]),
        tbl(
          "order_lines",
          [
            { name: "id", type: { kind: "uuid" as const }, nullable: false },
            { name: "order_id", type: { kind: "uuid" as const }, nullable: false },
          ],
          {
            foreignKeys: [{ column: "order_id", refTable: "orders", onDelete: "cascade" }],
          },
        ),
      ],
    };
    const steps = diffSchema(prev, { schemaVersion: 1, tables: [] });
    const drops = steps
      .filter((s): s is Extract<MigrationStep, { op: "dropTable" }> => s.op === "dropTable")
      .map((s) => s.name);
    // Child first — otherwise "cannot drop table orders … order_lines depends on it".
    expect(drops).toEqual(["order_lines", "orders"]);
  });

  it("emits column-level FK drops before the table drops they unblock", () => {
    // `orders` survives but loses its FK column to `regions`; `regions` is
    // dropped.  The dropColumn on orders must precede the dropTable on regions.
    const prev = {
      schemaVersion: 1 as const,
      tables: [
        tbl(
          "orders",
          [
            { name: "id", type: { kind: "uuid" as const }, nullable: false },
            { name: "region_id", type: { kind: "uuid" as const }, nullable: false },
          ],
          { foreignKeys: [{ column: "region_id", refTable: "regions", onDelete: "restrict" }] },
        ),
        tbl("regions", [{ name: "id", type: { kind: "uuid" as const }, nullable: false }]),
      ],
    };
    const next = {
      schemaVersion: 1 as const,
      tables: [tbl("orders", [{ name: "id", type: { kind: "uuid" as const }, nullable: false }])],
    };
    const steps = applyDestructivePolicy(diffSchema(prev, next), prev, {
      allowDestructive: true,
      module: "M",
    });
    const dropColIdx = steps.findIndex((s) => s.op === "dropColumn" && s.name === "region_id");
    const dropTblIdx = steps.findIndex((s) => s.op === "dropTable" && s.name === "regions");
    expect(dropColIdx).toBeGreaterThanOrEqual(0);
    expect(dropTblIdx).toBeGreaterThan(dropColIdx);
  });
});

describe("A8.3 — destructive-change gate", () => {
  const idCol = { name: "id", type: { kind: "uuid" as const }, nullable: false };

  it("collapses a same-type drop+add on one table into a renameColumn", () => {
    const prev = {
      schemaVersion: 1 as const,
      tables: [
        tbl("users", [
          idCol,
          { name: "full_name", type: { kind: "text" as const }, nullable: false },
        ]),
      ],
    };
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl("users", [idCol, { name: "name", type: { kind: "text" as const }, nullable: false }]),
      ],
    };
    const steps = applyDestructivePolicy(diffSchema(prev, next), prev, {
      allowDestructive: false,
      module: "M",
    });
    expect(steps).toEqual([
      {
        op: "renameColumn",
        table: "users",
        from: "full_name",
        to: "name",
        type: { kind: "text" },
      },
    ]);
    expect(renderPgStep(steps[0]!)).toBe(
      'ALTER TABLE "users" RENAME COLUMN "full_name" TO "name";',
    );
  });

  it("does NOT collapse when the drop/add types differ (stays destructive)", () => {
    const prev = {
      schemaVersion: 1 as const,
      tables: [
        tbl("users", [idCol, { name: "age", type: { kind: "text" as const }, nullable: false }]),
      ],
    };
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl("users", [idCol, { name: "years", type: { kind: "int" as const }, nullable: false }]),
      ],
    };
    expect(() =>
      applyDestructivePolicy(diffSchema(prev, next), prev, {
        allowDestructive: false,
        module: "M",
      }),
    ).toThrow(MigrationDestructiveError);
  });

  it("blocks a NOT-NULL add without a default on an existing table unless allowed", () => {
    const prev = { schemaVersion: 1 as const, tables: [tbl("orders", [idCol])] };
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl("orders", [
          idCol,
          { name: "status", type: { kind: "text" as const }, nullable: false },
        ]),
      ],
    };
    const raw = diffSchema(prev, next);
    expect(() =>
      applyDestructivePolicy(raw, prev, { allowDestructive: false, module: "M" }),
    ).toThrow(/migration-destructive|destructive/i);
  });

  it("--allow-destructive rewrites the NOT-NULL add into add-nullable + backfill-TODO + SET NOT NULL", () => {
    const prev = { schemaVersion: 1 as const, tables: [tbl("orders", [idCol])] };
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl("orders", [
          idCol,
          { name: "status", type: { kind: "text" as const }, nullable: false },
        ]),
      ],
    };
    const steps = applyDestructivePolicy(diffSchema(prev, next), prev, {
      allowDestructive: true,
      module: "M",
    });
    expect(steps.map((s) => s.op)).toEqual(["addColumn", "sqlComment", "alterColumnNullable"]);
    const add = steps[0]!;
    expect(add.op === "addColumn" && add.column.nullable).toBe(true);
    const setNotNull = steps[2]!;
    expect(setNotNull.op === "alterColumnNullable" && setNotNull.nullable).toBe(false);
    expect(renderPgStep(steps[1]!)).toMatch(/^-- TODO backfill orders\.status/);
  });

  it("exempts first-run (Initial) migrations — nothing pre-exists to destroy", () => {
    const next = {
      schemaVersion: 1 as const,
      tables: [
        tbl("orders", [
          idCol,
          { name: "status", type: { kind: "text" as const }, nullable: false },
        ]),
      ],
    };
    // baseline null → createTable carries the NOT-NULL column inline; no gate.
    const steps = applyDestructivePolicy(diffSchema(null, next), null, {
      allowDestructive: false,
      module: "M",
    });
    expect(steps.every((s) => s.op === "createTable")).toBe(true);
  });
});
