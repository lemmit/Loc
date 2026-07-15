import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — shape: embedded (F2b).  The root stays a normal
// queryable row (`id` + flattened scalar / `X id` columns), so finds run
// as real SQL; each containment folds into one jsonb column and reference
// collections (`X id[]`) fold into a jsonb id-array column — no part /
// join tables.  Containments (de)serialise through the same to_doc /
// from_doc helpers the document repo uses.  Verified live (create →
// addLine → retotal → read-back → byCustomer) and statically by the
// `embedded.ddd` corpus case (uv + ruff + mypy --strict).
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/embedded.ddd"),
  "utf8",
);

async function build() {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python shape: embedded", () => {
  it("root row keeps scalar / id columns and folds containments + ref collections into jsonb", async () => {
    const files = await build();
    const schema = files.get("api/app/db/schema.py")!;
    expect(schema).toContain("class OrderRow(Base):");
    expect(schema).toContain("customer: Mapped[str] = mapped_column(Text)");
    expect(schema).toContain("total: Mapped[Decimal] = mapped_column(Numeric(19, 4))");
    // ref collection + each containment → one jsonb column each.
    expect(schema).toContain("tags: Mapped[object] = mapped_column(JSONB)");
    expect(schema).toContain("lines: Mapped[object] = mapped_column(JSONB)");
    expect(schema).toContain("note: Mapped[object] = mapped_column(JSONB)");
    // No normalised part table for the contained LineItem / Memo.
    expect(schema).not.toContain("class LineItemRow(Base):");
    expect(schema).not.toContain("class MemoRow(Base):");
  });

  it("save folds children to jsonb via to_doc + an upsert; hydrate rebuilds via from_doc", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    // root upsert with folded children.
    expect(repo).toContain('"tags": [str(__x) for __x in aggregate.tags]');
    expect(repo).toContain('"lines": [_line_item_to_doc(__e) for __e in aggregate.lines]');
    expect(repo).toContain(
      '"note": (None if aggregate.note is None else _memo_to_doc(aggregate.note))',
    );
    // Default-on versioning (M-T3.4): the upsert is the guarded write — an
    // INSERT-conflict only overwrites when the stored version still matches the
    // caller's expected value, bumping it by one; a stale write returns no row →
    // ConcurrencyError.
    expect(repo).toContain(
      "async def save(self, aggregate: Order, expected_version: int | None = None) -> None:",
    );
    expect(repo).toContain(
      "_expected = aggregate.version if expected_version is None else expected_version",
    );
    expect(repo).toContain('index_elements=["id"],');
    expect(repo).toContain('"version": OrderRow.version + 1');
    expect(repo).toContain("where=OrderRow.version == _expected,");
    expect(repo).toContain("if _guarded.first() is None:");
    // async hydrate from row columns + jsonb children.
    expect(repo).toContain("async def _hydrate(self, row: OrderRow) -> Order:");
    expect(repo).toContain("customer=row.customer");
    expect(repo).toContain("tags=[TagId(cast(str, __x)) for __x in cast(list[object], row.tags)]");
    expect(repo).toContain(
      "lines=[_line_item_from_doc(__x) for __x in cast(list[object], row.lines)]",
    );
    expect(repo).toContain("note=(None if row.note is None else _memo_from_doc(row.note))");
    // part serialisers reused from the document builder.
    expect(repo).toContain("def _line_item_to_doc(a: LineItem) -> dict[str, object]:");
    expect(repo).toContain("def _memo_from_doc(raw: object) -> Memo:");
  });

  it("finds run as real SQL over the root columns (not in-memory)", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("async def by_customer(self, name: str) -> list[Order]:");
    expect(repo).toContain("select(OrderRow).where((OrderRow.customer == name))");
    expect(repo).toContain("return [await self._hydrate(row) for row in rows]");
  });

  it("list finds stay on per-row _hydrate — embedded repo emits no _hydrate_many", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    // The embedded repo loads the whole aggregate from one jsonb column, so
    // there is no per-row child SELECT to batch — it reuses the shared find
    // emitters but must never route them through the relational `_hydrate_many`
    // (which it doesn't define). Every list read stays on the comprehension.
    expect(repo).not.toContain("_hydrate_many");
    expect(repo).toContain("items = [await self._hydrate(row) for row in rows]");
  });
});
