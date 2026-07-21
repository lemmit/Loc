import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Context integration test emission on the Python/FastAPI backend
// (test-placement.md, Phase 3b). A `context`-nested `test` (no `for`) emits an
// in-process, repository-backed `tests/test_<ctx>_integration.py` that reads
// LOOM_PG_URL, applies the SQL migrations, wires the repos, and persists→reads.
// A create persists via `repo.save`; a find awaits a repo read (find_by_id
// nullable → `assert is not None`). Verified end-to-end: the emitted module
// passes mypy --strict + ruff and runs green against a real Postgres.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
  subdomain Sales { context Ordering {
    aggregate Order { code: string  qty: int }
    repository Orders for Order { }
    test "persists and reads back an order" {
      let o = Order.create({ code: "abc", qty: 2 })
      let found = Order.findById(o.id)
      expect(found.qty).toBe(2)
    }
  } }
  api ShopApi from Sales
  storage db { type: postgres }
  resource st { for: Ordering, kind: state, use: db }
  deployable api { platform: python contexts: [Ordering] serves: ShopApi dataSources: [st] port: 8080 }
}`;

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  expect(errors, "parse/validate errors").toEqual([]);
  return generateSystems(model).files;
}

const find = (files: Map<string, string>, suffix: string): string | undefined =>
  [...files.entries()].find(([p]) => p.endsWith(suffix))?.[1];

describe("Python: context integration test emission (Phase 3b)", () => {
  it("emits tests/test_<ctx>_integration.py with the in-process boot + persist/read body", async () => {
    const files = await gen(SRC);
    const f = find(files, "tests/test_ordering_integration.py");
    expect(f, "test_ordering_integration.py").toBeDefined();
    // Provisioning-agnostic boot: reads LOOM_PG_URL, migrates, per-test session.
    expect(f).toContain('os.environ.get("LOOM_PG_URL"');
    expect(f).toContain("await run_migrations(engine)");
    expect(f).toContain("from app.domain.events import NoopDomainEventDispatcher");
    expect(f).toContain("order_repo = OrderRepository(session, events)");
  });

  it("renders create→save, find→await (nullable asserted), and the assertion", async () => {
    const f = (await gen(SRC)).get("api/tests/test_ordering_integration.py") ?? "";
    expect(f).toMatch(/o = Order\.create\([^)]*\)/);
    expect(f).toContain("await order_repo.save(o)");
    expect(f).toContain("found = await order_repo.find_by_id(o.id)");
    expect(f).toContain("assert found is not None");
    expect(f).toContain("assert found.qty == 2");
  });

  it("emits nothing for a context with no integration test", async () => {
    const files = await gen(SRC.replace(/test "persists[\s\S]*?\}\n/, ""));
    expect(find(files, "integration.py")).toBeUndefined();
  });

  it("wires the SYNCHRONOUS InProcessDispatcher when the context runs workflows", async () => {
    const withWorkflow = `
system Ship {
  subdomain F { context Fulfillment {
    aggregate Order {
      customerId: string  status: string
      operation place() { precondition status == "Draft"  status := "Placed"  emit OrderPlaced { order: id, at: now() } }
    }
    repository Orders for Order { }
    aggregate Shipment { orderRef: Order id  status: string }
    repository Shipments for Shipment { }
    event OrderPlaced { order: Order id, at: datetime }
    channel Lifecycle { carries: OrderPlaced  delivery: queue  retention: log }
    workflow OrderFulfillment {
      orderId: Order id
      create(p: OrderPlaced) by p.order { let s = Shipment.create({ orderRef: p.order, status: "Pending" }) }
    }
    test "placing transitions to Placed" {
      let o = Order.create({ customerId: "c1", status: "Draft" })
      o.place()
      let found = Order.findById(o.id)
      expect(found.status).toBe("Placed")
    }
  } }
  api FApi from F
  storage pg { type: postgres }
  resource st { for: Fulfillment, kind: state, use: pg }
  deployable d { platform: python contexts: [Fulfillment] serves: FApi dataSources: [st] port: 4000 }
}`;
    const f = find(await gen(withWorkflow), "tests/test_fulfillment_integration.py");
    expect(f, "test_fulfillment_integration.py").toBeDefined();
    expect(f).toContain("from app.dispatch import InProcessDispatcher");
    expect(f).toContain("events = InProcessDispatcher(session)");
    // op → mutate-in-place + save (the emit fans out through the dispatcher).
    expect(f).toContain("o.place()");
    expect(f).toContain("await order_repo.save(o)");
  });
});
