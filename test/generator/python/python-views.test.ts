import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — criteria / retrievals (plan S11).  Criteria
// inline into find/retrieval predicates (the IR contract explicitly
// supports non-reifying backends); retrievals emit run_<name> with
// sort + call-site offset/limit.  Verified live against Postgres
// during the slice.
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
});
