import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — aggregate emission (plan S5): the domain class shape
// (private backing fields + properties, keyword-only full-state
// __init__ asserting invariants, _create rehydration alias, public
// create factory on constructible roots), operations with
// precondition guards + trailing invariant re-assert, functions as
// private methods, parts as sibling classes with parent_id, the
// _events buffer + pull_events, and the __repr__/inspect hook.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/domain.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python aggregate emission", () => {
  it("emits part classes before the root in the aggregate module", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order.indexOf("class OrderLine:")).toBeGreaterThan(-1);
    expect(order.indexOf("class OrderLine:")).toBeLessThan(order.indexOf("class Order:"));
  });

  it("__init__ takes keyword-only full state and asserts invariants on domain construction", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain(
      "def __init__(self, *, id: OrderId, status: OrderStatus, placed_at: datetime, unit_budget: Decimal, watchers: list[CustomerId], version: int, lines: list[OrderLine], _trust_store: bool = False) -> None:",
    );
    // RS-10: the invariant run is gated on the trust marker — repository
    // rehydration (`_rehydrate`) skips it, domain construction asserts.
    expect(order).toContain("        if not _trust_store:");
    expect(order).toContain("            self._assert_invariants()");
    expect(order).toContain("        self._events: list[DomainEvent] = []");
    expect(order).toContain("    def _rehydrate(");
    expect(order).toContain("_trust_store=True)");
  });

  it("parts carry parent_id and their own invariants", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("parent_id: OrderId");
    expect(order).toContain("    def parent_id(self) -> OrderId:");
    expect(order).toContain('            raise DomainError("Invariant violated: quantity > 0")');
  });

  it("operations guard preconditions and re-assert invariants when void", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("    def add_line(self, qty: int, price: Money) -> None:");
    expect(order).toContain("        if not (self._is_mutable()):");
    expect(order).toContain('            raise DomainError("Precondition failed: isMutable()")');
    // Trailing re-assert.
    expect(order).toMatch(/add_line[\s\S]*?self\._assert_invariants\(\)/);
  });

  it("private operations and functions are _-prefixed", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("    def _require_mutable(self) -> None:");
    expect(order).toContain("    def _is_mutable(self) -> bool:");
  });

  it("emit lowers to event dataclass appends; new parts route through _create", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("self._events.append(LineAdded(order=self._id, quantity=qty))");
    expect(order).toContain(
      "self._lines.append(OrderLine._create(id=new_order_line_id(), parent_id=self._id, quantity=qty, unit_price=price))",
    );
  });

  it("derived render as properties (collection sum via generator expression)", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("    def total(self) -> Money:");
    expect(order).toContain(
      'Money(sum((lambda l: l.subtotal.amount)(__x) for __x in self._lines), "USD")',
    );
  });

  it("guarded invariants render guard-and-not shape", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain(
      "        if (self._status == OrderStatus.Confirmed) and not (len(self._lines) > 0):",
    );
  });

  it("the root exposes pull_events and the __repr__ inspect hook", async () => {
    const files = await build();
    const order = files.get("api/app/domain/order.py")!;
    expect(order).toContain("    def pull_events(self) -> list[DomainEvent]:");
    expect(order).toContain("    def __repr__(self) -> str:");
    expect(order).toContain("        return self.inspect");
  });

  it("constructible aggregates get a public create factory with new id + seeds", async () => {
    const { model, errors } = await parseString(`system PyCreate {
      subdomain Ops {
        context Ops {
          aggregate Widget {
            label: string
            createdAt: datetime managed
            note: string?
          }
          repository Widgets for Widget { }
        }
      }
      api OpsApi from Ops
      storage pg { type: postgres }
      resource opsState { for: Ops, kind: state, use: pg }
      deployable api {
        platform: python
        contexts: [Ops]
        dataSources: [opsState]
        serves: OpsApi
        port: 8000
      }
    }`);
    expect(errors).toEqual([]);
    const files = generateSystems(model).files;
    const widget = files.get("api/app/domain/widget.py")!;
    expect(widget).toContain(
      '    def create(cls, *, label: str, note: str | None = None) -> "Widget":',
    );
    expect(widget).toContain("            id=new_widget_id(),");
    // Server-owned managed datetime seeds a UTC stamp.
    expect(widget).toContain("            created_at=datetime.now(UTC),");
  });
});
