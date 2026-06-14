import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — shape(embedded) (F2b).  The root stays a normal
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

describe("python shape(embedded)", () => {
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
    expect(repo).toContain('on_conflict_do_update(index_elements=["id"], set_=root)');
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
});
