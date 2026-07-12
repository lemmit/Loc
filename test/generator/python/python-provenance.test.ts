import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Provenance runtime on the Python (FastAPI / SQLAlchemy 2 async) backend — W2.
//
// A `provenanced` field gets a co-located `<field>_provenance` jsonb backing
// column; every named-operation write to it captures a lineage (rule snapshot
// + leaf inputs + computed value) onto a per-request `contextvars.ContextVar`
// buffer, and the repository's `save` drains that buffer into the
// `provenance_records` history table BEFORE its `flush()` (no nested
// transaction — the request-scoped session commits once, so the history is
// atomic with the aggregate).  The shared SDK (`app/domain/provenance.py`
// ContextVar buffer + `app/db/provenance.py` history model) and a LATE
// hand-emitted migration (ALTER backing columns + CREATE history) ride along.
//
// The python gate is un-gated (PROVENANCE_BACKENDS, system-checks).  This is a
// mechanical mirror of node / .NET / elixir-vanilla.
// ---------------------------------------------------------------------------

const SOURCE = `
system OrderingSystem {
  subdomain Ordering {
    context Ordering {
      aggregate Order with crudish {
        reference: string
        quantity: int
        unitPrice: int
        discount: int
        total: int provenanced
        operation reprice(qty: int, price: int) {
          precondition qty > 0
          precondition price >= 0
          quantity := qty
          unitPrice := price
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
  api OrderingApi from Ordering
  storage primary { type: postgres }
  resource orderingState { for: Ordering, kind: state, use: primary }
  deployable d {
    platform: python
    contexts: [Ordering]
    dataSources: [orderingState]
    serves: OrderingApi
    port: 4000
  }
}
`;

// A second system with no provenanced field — to assert the runtime is gated
// (no SDK / migration / capture / column) when nothing is marked.
const PLAIN = `
system Plain {
  subdomain Core {
    context Stock {
      aggregate Item with crudish {
        total: int
        operation bump() { total := total + 1 }
      }
      repository Items for Item { }
    }
  }
  api StockApi from Core
  storage primary { type: postgres }
  resource itemState { for: Stock, kind: state, use: primary }
  deployable d {
    platform: python
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

describe("python provenance runtime (W2)", () => {
  it("emits the provenance SDK — ContextVar buffer + ProvLineage dataclass", async () => {
    const prov = file(await generateSystemFiles(SOURCE), "/app/domain/provenance.py");
    expect(prov).toContain("from contextvars import ContextVar");
    expect(prov).toContain("class ProvLineage:");
    expect(prov).toContain(
      '_trace_buffer: ContextVar[list[ProvLineage]] = ContextVar("loom_prov_traces")',
    );
    expect(prov).toContain("def record(lineage: ProvLineage) -> ProvLineage:");
    expect(prov).toContain("def drain() -> list[ProvLineage]:");
    // The camelCase jsonb shape shared with the other backends.
    expect(prov).toContain('"snapshotId": self.snapshot_id');
    expect(prov).toContain('"computedValue": self.computed_value');
  });

  it("emits the provenance_records history model (governance stamps)", async () => {
    const db = file(await generateSystemFiles(SOURCE), "/app/db/provenance.py");
    expect(db).toContain("class ProvenanceRecord(Base):");
    expect(db).toContain('__tablename__ = "provenance_records"');
    expect(db).toContain("correlation_id: Mapped[str | None]");
    expect(db).toContain("scope_id: Mapped[str | None]");
    expect(db).toContain("actor_id: Mapped[str | None]");
    expect(db).toContain("parent_id: Mapped[str | None]");
  });

  it("adds the co-located `<field>_provenance` jsonb column to the schema model", async () => {
    const schema = file(await generateSystemFiles(SOURCE), "/app/db/schema.py");
    expect(schema).toContain("total_provenance: Mapped[object | None] = mapped_column(JSONB)");
    // The declared column is untouched.
    expect(schema).toContain("total: Mapped[int]");
  });

  it("captures lineage inline at each named-op write site", async () => {
    const agg = file(await generateSystemFiles(SOURCE), "/app/domain/order.py");
    // Leaf inputs snapshotted (params + the sibling `discount`).
    expect(agg).toContain('ProvInput(path="qty", value=qty)');
    expect(agg).toContain('ProvInput(path="discount", value=self._discount)');
    // The lineage (snapshot id + target + computed value), routed to both
    // sinks — the co-located backing field + the ContextVar buffer.
    expect(agg).toContain('target=ProvTarget(type="Order", field="total")');
    expect(agg).toContain("computed_value=self._total");
    expect(agg).toContain("self._total_provenance = __lin_0");
    expect(agg).toContain("record(__lin_0)");
  });

  it("snapshots a self-referential write's leaf BEFORE the mutation", async () => {
    const agg = file(await generateSystemFiles(SOURCE), "/app/domain/order.py");
    // applyDiscount does `total := total - amount` — the `self._total` leaf
    // must be captured into __prov_0 before the `self._total = …` rebind.
    const inputsIdx = agg.indexOf('ProvInput(path="total", value=self._total)');
    const writeIdx = agg.indexOf("self._total = self._total - amount");
    expect(inputsIdx).toBeGreaterThan(-1);
    expect(writeIdx).toBeGreaterThan(-1);
    expect(inputsIdx).toBeLessThan(writeIdx);
  });

  it("persists the co-located column and flushes records before save flush()", async () => {
    const repo = file(await generateSystemFiles(SOURCE), "/order_repository.py");
    // Co-located column on the upsert root dict.
    expect(repo).toContain('"total_provenance": (aggregate.total_provenance.to_wire()');
    // Drain → insert provenance_records, stamped with the request-context ids.
    expect(repo).toContain("__traces = drain()");
    expect(repo).toContain("insert(ProvenanceRecord)");
    expect(repo).toContain('"correlation_id": correlation_id()');
    // The flush insert comes BEFORE the save flush() — one request transaction.
    const insertIdx = repo.indexOf("insert(ProvenanceRecord)");
    const flushIdx = repo.indexOf("await self._session.flush()");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(flushIdx).toBeGreaterThan(insertIdx);
    // No nested transaction opened in the repository.
    expect(repo).not.toContain("session.begin()");
  });

  it("restores the lineage on hydrate and exposes it on the Pydantic response", async () => {
    const files = await generateSystemFiles(SOURCE);
    const repo = file(files, "/order_repository.py");
    expect(repo).toContain("ProvLineage.from_wire(row.total_provenance)");
    expect(repo).toContain('"total_provenance": (root.total_provenance.to_wire()');
    const routes = file(files, "/app/http/order_routes.py");
    expect(routes).toContain("total_provenance: dict[str, object] | None = None");
  });

  it("emits the LATE provenance migration (ALTER column + CREATE history)", async () => {
    const mig = file(await generateSystemFiles(SOURCE), "_provenance.sql");
    // The orders table lives in the `ordering` schema — the ALTER is qualified.
    expect(mig).toContain('ALTER TABLE "ordering".orders ADD COLUMN "total_provenance" jsonb;');
    expect(mig).toContain("CREATE TABLE provenance_records (");
    expect(mig).toContain('"snapshot_id" text NOT NULL');
    expect(mig).toContain("--> statement-breakpoint");
  });

  it("the migration sorts after every module migration", async () => {
    const files = await generateSystemFiles(SOURCE);
    const sqlFiles = [...files.keys()].filter((k) => k.endsWith(".sql"));
    const provFile = sqlFiles.find((k) => k.endsWith("_provenance.sql"));
    expect(provFile).toBeDefined();
    const others = sqlFiles.filter((k) => k !== provFile).map((k) => k.split("/").pop()!);
    const provName = provFile!.split("/").pop()!;
    for (const other of others) expect(provName > other).toBe(true);
  });

  it("is gated: no SDK / migration / capture / column when nothing is provenanced", async () => {
    const files = await generateSystemFiles(PLAIN);
    expect([...files.keys()].some((k) => k.endsWith("/app/domain/provenance.py"))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("/app/db/provenance.py"))).toBe(false);
    expect([...files.keys()].some((k) => k.endsWith("_provenance.sql"))).toBe(false);
    const agg = file(files, "/app/domain/item.py");
    expect(agg).not.toContain("record(");
    expect(agg).not.toContain("ProvLineage");
    const schema = file(files, "/app/db/schema.py");
    expect(schema).not.toContain("_provenance");
  });
});
