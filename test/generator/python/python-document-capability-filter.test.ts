import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Python backend — capability `filter` on a shape: document aggregate
// (DEBT-02 tail).  The jsonb blob isn't per-field queryable, so the predicate
// is evaluated IN-APP over the REHYDRATED domain instance (a list-comprehension
// filter), the SQLAlchemy analogue of node's `documentCapabilityBody`
// `.filter(...)` — NOT a SQL `where` like the relational / embedded paths.
// Both shapes wired: a non-principal filter (`!this.archived`) and a principal
// filter (`this.tenantId == currentUser.tenantId`, bound against the ambient
// `require_current_user()` accessor).  Statically gated ruff + mypy --strict by
// the `document-tenancy.ddd` python-build case.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(
  path.resolve(here, "../../e2e/fixtures/python-build/document-tenancy.ddd"),
  "utf8",
);

async function repo(): Promise<string> {
  const { model, errors } = await parseString(FIXTURE);
  if (errors.length) throw new Error(`fixture has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files.get("api/app/db/repositories/article_repository.py")!;
}

describe("python shape: document capability filter", () => {
  it("imports the ambient principal accessor (not a read-method param)", async () => {
    expect(await repo()).toContain("from app.auth.user import require_current_user");
  });

  it("gates find_by_id by the in-app predicate (hidden → not-found)", async () => {
    const r = await repo();
    expect(r).toContain("current_user = require_current_user()");
    expect(r).toContain("rec = _article_from_doc(row.data, row.version)");
    expect(r).toContain(
      "if not ((not rec.archived) and (rec.tenant_id == current_user.tenant_id)):",
    );
    expect(r).toContain("            return None");
  });

  it("filters all() over the rehydrated documents", async () => {
    expect(await repo()).toContain(
      "return [x for x in (_article_from_doc(r.data, r.version) for r in rows) " +
        "if ((not x.archived) and (x.tenant_id == current_user.tenant_id))]",
    );
  });

  it("filters find_many_by_ids by the capability predicate", async () => {
    const r = await repo();
    // The id-restricted SQL read still rehydrates + filters in-app.
    expect(r).toContain("select(ArticleRow).where(ArticleRow.id.in_(list(ids)))");
    expect(r).toContain(
      "return [x for x in (_article_from_doc(r.data, r.version) for r in rows) " +
        "if ((not x.archived) and (x.tenant_id == current_user.tenant_id))]",
    );
  });

  it("applies the capability predicate BEFORE a custom find's own where (raw load)", async () => {
    const r = await repo();
    // Custom find reads a RAW load (not the already-filtered all()) and AND-s
    // the capability predicate with its own where, so bypass can drop a conjunct.
    expect(r).toContain("items = [_article_from_doc(r.data, r.version) for r in rows]");
    expect(r).toContain(
      "result = [x for x in items if ((not x.archived) and " +
        "(x.tenant_id == current_user.tenant_id)) and (x.view_count >= min)]",
    );
  });
});
