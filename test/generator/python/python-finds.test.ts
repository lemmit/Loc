import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — user-declared finds (plan S8): `where` clauses lower
// to SQLAlchemy predicates over the Row class (comparisons, and_/or_/
// not_, VO sub-columns, enum values, `<refColl>.contains` → correlated
// EXISTS against the join table); clause-less finds convention-match
// params to columns.  Find routes register BEFORE /{id} (Starlette
// matches in declaration order).  Verified live against Postgres
// during the slice (by_status / cheaper_than / watched_by / by_name).
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

describe("python find lowering", () => {
  it("comparison predicates lower to column expressions", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain("async def by_status(self, status: OrderStatus) -> list[Order]:");
    expect(repo).toContain("select(OrderRow).where((OrderRow.status == status))");
    expect(repo).toContain("async def cheaper_than(self, limit: Decimal) -> list[Order]:");
    expect(repo).toContain("select(OrderRow).where((OrderRow.unit_budget <= limit))");
  });

  it("refColl.contains lowers to a correlated EXISTS on the join table", async () => {
    const files = await build();
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo).toContain(
      "select(OrderWatchersRow).where(OrderWatchersRow.order_id == OrderRow.id, OrderWatchersRow.customer_id == customer_id).exists()",
    );
  });

  it("find routes register before /{id} with coerced query params", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes).toContain(
      '@router.get("/by_status", response_model=OrderListResponse, operation_id="byStatusOrder")',
    );
    expect(routes).toContain(
      "async def by_status_orders(status: OrderStatus, session: SessionDep) -> list[dict[str, object]]:",
    );
    expect(routes).toContain("await repo.watched_by(CustomerId(customerId))");
    // A `money` find param arrives as a wire string and is branded back to the
    // `Decimal` the repo expects at the wire→domain seam (request-side parity).
    expect(routes).toContain(
      "async def cheaper_than_orders(limit: str, session: SessionDep) -> list[dict[str, object]]:",
    );
    expect(routes).toContain("await repo.cheaper_than(Decimal(limit))");
    // Declaration order: finds precede the /{id} pattern.
    expect(routes.indexOf('@router.get("/by_status"')).toBeLessThan(
      routes.indexOf('@router.get("/{id}"'),
    );
  });

  it("the auto `all` find stays the dedicated method/route pair (no dupes)", async () => {
    const files = await build();
    const routes = files.get("api/app/http/order_routes.py")!;
    expect(routes.match(/@router\.get\(""/g)?.length).toBe(1);
    const repo = files.get("api/app/db/repositories/order_repository.py")!;
    expect(repo.match(/async def all\(/g)?.length).toBe(1);
  });
});
