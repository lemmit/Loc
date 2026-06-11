import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — criteria / retrievals / views (plan S11).  Criteria
// inline into find/retrieval predicates (the IR contract explicitly
// supports non-reifying backends); retrievals emit run_<name> with
// sort + call-site offset/limit; views emit GET /views/<snake> routes
// (shorthand → to_wire list; full form → bind projection over
// hydrated rows).  Verified live against Postgres during the slice.
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

describe("python retrievals", () => {
  it("emits run_<name> with inlined criterion predicate, sort, offset/limit", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain(
      "async def run_by_status_sorted(self, s: OrderStatus, offset: int | None = None, limit: int | None = None) -> list[Order]:",
    );
    expect(repo).toContain(
      "query = select(OrderRow).where((OrderRow.status == s)).order_by(OrderRow.placed_at.desc())",
    );
    expect(repo).toContain("query = query.offset(offset)");
    expect(repo).toContain("query = query.limit(limit)");
  });

  it("emits find_many_by_ids (the views bulk loader)", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("async def find_many_by_ids(self, ids: list[OrderId]) -> list[Order]:");
  });
});

describe("python views", () => {
  it("shorthand views project the source wire shape through to_wire", async () => {
    const files = await build();
    const views = files.get("api/app/http/views_routes.py")!;
    expect(views).toContain(
      '@router.get("/draft_orders", response_model=OrderListResponse, operation_id="draftOrdersView")',
    );
    expect(views).toContain("return [repo.to_wire(r) for r in await repo.draft_orders()]");
    // The repo gains the synthesised view find with the lowered filter.
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("async def draft_orders(self) -> list[Order]:");
    expect(repo).toContain("select(OrderRow).where((OrderRow.status == OrderStatus.Draft))");
  });

  it("full-form views project binds over hydrated rows (money as string)", async () => {
    const files = await build();
    const views = files.get("api/app/http/views_routes.py")!;
    expect(views).toContain("class OrderSummariesRow(BaseModel):");
    expect(views).toContain("    orderId: str");
    expect(views).toContain("    budget: str");
    expect(views).toContain('"orderId": r.id,');
    expect(views).toContain('"budget": str(r.unit_budget),');
    expect(views).toContain('"lineCount": len(r.lines),');
    const main = files.get("api/app/main.py")!;
    expect(main).toContain("from app.http.views_routes import router as views_router");
    expect(main).toContain("app.include_router(views_router)");
  });
});
