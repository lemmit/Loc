import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — SQLAlchemy persistence + repositories (plan S6).
// Table/column/index naming mirrors the Drizzle schema (snake columns,
// plural tables, `<parent>_id` FK behind the parent_id attribute, join
// tables with composite PK + reverse index) so every backend shares one
// Postgres DDL.
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

describe("python schema emission", () => {
  it("emits typed declarative rows with drizzle-parity naming", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class OrderRow(Base):");
    expect(schema).toContain('    __tablename__ = "orders"');
    expect(schema).toContain(
      "    id: Mapped[str] = mapped_column(Uuid(as_uuid=False), primary_key=True)",
    );
    // money → NUMERIC(19,4); datetime → timezone-aware.
    expect(schema).toContain("    unit_budget: Mapped[Decimal] = mapped_column(Numeric(19, 4))");
    expect(schema).toContain(
      "    placed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))",
    );
  });

  it("part tables FK the parent via <parent>_id behind the parent_id attr", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain('    __tablename__ = "order_lines"');
    expect(schema).toContain(
      '    parent_id: Mapped[str] = mapped_column("order_id", Uuid(as_uuid=False))',
    );
    // Index name keys off the real FK column, matching the migration.
    expect(schema).toContain('Index("order_lines_order_id_idx", "order_id")');
    // VO fields flatten to prefixed columns.
    expect(schema).toContain("    unit_price_amount: Mapped[Decimal] = mapped_column(Numeric)");
    expect(schema).toContain("    unit_price_currency: Mapped[str] = mapped_column(Text)");
  });

  it("ref collections emit a join table with composite PK + reverse index (set semantics, no ordinal)", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class OrderWatchersRow(Base):");
    expect(schema).toContain('    __tablename__ = "order_watchers"');
    expect(schema).toContain('PrimaryKeyConstraint("order_id", "customer_id")');
    expect(schema).toContain('Index("order_watchers_customer_id_idx", "customer_id")');
    // `Id<T>[]` is a set (membership only, no order): the composite PK is the
    // whole join row, so it carries NO ordinal column.  Scope the check to the
    // join model body (the VO-collection child table keeps its own ordinal).
    const joinModel = schema.slice(
      schema.indexOf("class OrderWatchersRow(Base):"),
      schema.indexOf("class ", schema.indexOf("class OrderWatchersRow(Base):") + 1),
    );
    expect(joinModel).not.toContain("ordinal");
  });
});

describe("python repository emission", () => {
  it("find_by_id / get_by_id / all with hydration through _create", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("async def find_by_id(self, id: OrderId) -> Order | None:");
    expect(repo).toContain("async def get_by_id(self, id: OrderId) -> Order:");
    expect(repo).toContain('raise AggregateNotFoundError(f"Order {id} not found")');
    expect(repo).toContain("async def all(self) -> list[Order]:");
    expect(repo).toContain("return Order._create(");
    expect(repo).toContain("id=OrderId(row.id),");
  });

  it("hydration converts enums / decimals / VO flattened columns", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("status=OrderStatus(row.status),");
    expect(repo).toContain(
      "unit_price=Money(float(row.unit_price_amount), row.unit_price_currency),",
    );
    // Ref collection loads join rows ordered by the target FK id and brands ids.
    expect(repo).toContain(".order_by(OrderWatchersRow.customer_id)");
    expect(repo).toContain("watchers=[CustomerId(__r.customer_id) for __r in watchers_rows],");
  });

  it("save upserts the root, diff-syncs parts and join tables, drains events", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain(
      'insert(OrderRow).values(**root).on_conflict_do_update(index_elements=["id"], set_=root)',
    );
    expect(repo).toContain("lines_stale = [__id for __id in lines_existing");
    expect(repo).toContain("delete(OrderLineRow).where(OrderLineRow.id.in_(lines_stale))");
    // Set semantics: the join row is just its (owner, target) PK — no ordinal.
    expect(repo).toContain('pair = {"order_id": aggregate.id, "customer_id": __t}');
    expect(repo).toContain("insert(OrderWatchersRow).values(**pair).on_conflict_do_nothing(");
    expect(repo).toContain("for event in aggregate.pull_events():");
    expect(repo).toContain("await self._events.dispatch(event)");
    expect(repo).toContain("await self._session.flush()");
  });

  it("decimal domain floats persist via a Decimal(str(…)) round-trip", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain('"unit_price_amount": Decimal(str(child.unit_price.amount)),');
  });

  it("to_wire projects the canonical wire shape with nested parts + ISO datetimes", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("def to_wire(self, root: Order) -> dict[str, object]:");
    expect(repo).toContain('"id": root.id,');
    expect(repo).toContain('"placedAt": iso(root.placed_at),');
    expect(repo).toContain('"lines": [self._wire_order_line(__e) for __e in root.lines],');
    // Derived VO rides the wire as a nested object.
    expect(repo).toContain(
      '"total": {"amount": root.total.amount, "currency": root.total.currency},',
    );
    expect(repo).toContain("def _wire_order_line(self, e: OrderLine) -> dict[str, object]:");
  });
});
