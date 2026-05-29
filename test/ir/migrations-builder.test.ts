import { describe, expect, it } from "vitest";
import type { SchemaSnapshot } from "../../src/ir/types/migrations-ir.js";
import {
  BASE_TIMESTAMP,
  buildMigrations,
  diffSchema,
  schemaFromModule,
} from "../../src/system/migrations-builder.js";
import { memorySnapshotStore } from "../../src/system/snapshot.js";
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
      aggregate Order ids guid {
        customer: Customer id
        total: int
        contains lines: OrderLine[]
        entity OrderLine { quantity: int }
      }
      aggregate Customer ids guid {
        name: string
      }
      repository Orders for Order { }
      repository Customers for Customer { }
    }
  }
  deployable api { platform: hono, contexts: [Orders], port: 3000 }
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
    expect(orders.columns.map((c) => c.name)).toEqual(["id", "customer", "total"]);
    expect(orders.primaryKey).toEqual(["id"]);
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
    const out = buildMigrations(sys, memorySnapshotStore({ Sales: baseline }));
    expect(out[0]!.version).toBe(String(BigInt(BASE_TIMESTAMP) + 1n));
    expect(out[0]!.next.lastVersion).toBe(out[0]!.version);
    expect(out[0]!.name).not.toBe("Initial");
  });

  it("skips modules with no migrationsOwner", async () => {
    // Two modules, only one is reachable from a needsDb deployable.
    const loom = await buildLoomModel(`
system Twin {
  subdomain A { context Ca { aggregate X ids guid { n: int } } }
  subdomain B { context Cb { aggregate Y ids guid { n: int } } }
  deployable api { platform: hono, contexts: [Ca], port: 3000 }
}
`);
    const out = buildMigrations(loom.systems[0]!, memorySnapshotStore());
    expect(out.map((m) => m.module)).toEqual(["A"]);
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
  subdomain M { context C { aggregate X ids guid { n: int } } }
  storage pg { type: postgres }
  deployable first { platform: hono, contexts: [C], port: 3000 }
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
      aggregate Cart ids guid shape(document) {
        customer: Customer id
        total: int
        contains lines: CartLine[]
        entity CartLine { quantity: int }
      }
      aggregate Customer ids guid { name: string }
      repository Carts for Cart { }
      repository Customers for Customer { }
    }
  }
  deployable api { platform: hono, contexts: [Orders], port: 3000 }
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
    expect(customers.columns.map((c) => c.name)).toEqual(["id", "name"]);
  });
});

describe("buildMigrations — per-projection binding override", () => {
  it("honours a `dataSource shape: document` even when the aggregate header is shape(relational)", async () => {
    const loom = await buildLoomModel(`
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Cart ids guid shape(relational) { total: int }
      repository Carts for Cart { }
    }
  }
  storage pg { type: postgres }
  dataSource cartsState { for: Orders, kind: state, use: pg, shape: document }
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
