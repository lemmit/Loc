// ---------------------------------------------------------------------------
// Python backend — non-principal capability filters (W1a).  A relational
// aggregate carrying `filter !this.isDeleted` must AND that predicate into
// EVERY root-table read in the generated SQLAlchemy repository — SQLAlchemy
// has no automatic global filter (the EF Core HasQueryFilter analogue), so
// each read site (find_by_id, all, find_many_by_ids, the named finds) carries
// it explicitly via `contextFilterPredicate` (src/generator/python/
// find-predicate.ts), conjoined with `and_`.  Half-applying it would be a
// soft-delete correctness hole.  The node analogue is
// test/generator/typescript/context-filter-emit.test.ts; the java analogue is
// test/generator/java/generator-java-context-filter.test.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const REPO = "api/app/db/repositories/customer_repository.py";

const SRC = `
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Customer ids guid {
        name: string
        isDeleted: bool
        filter !this.isDeleted
      }
      repository Customers for Customer {
        find byName(n: string): Customer[] where name == n
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: python, contexts: [Sales], dataSources: [salesState], serves: SalesApi, port: 4000 }
}
`;

async function build(source: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`source has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python generator — capability filter (contextFilterPredicate)", () => {
  it("AND-s the non-principal filter into every root read site", async () => {
    const repo = (await build(SRC)).get(REPO)!;
    expect(repo).toBeDefined();

    // all(): the bare filter predicate (no id conjunction).
    expect(repo).toContain("select(CustomerRow).where(not_(CustomerRow.is_deleted))");
    // find_by_id: id predicate AND-ed with the filter.
    expect(repo).toContain(
      "select(CustomerRow).where(and_(CustomerRow.id == id, not_(CustomerRow.is_deleted)))",
    );
    // The named find by_name: its own where AND-ed with the filter.
    expect(repo).toContain(
      "select(CustomerRow).where(and_((CustomerRow.name == n), not_(CustomerRow.is_deleted)))",
    );
    // find_many_by_ids: the in_() predicate AND-ed with the filter.
    expect(repo).toContain(
      "select(CustomerRow).where(and_(CustomerRow.id.in_(list(ids)), not_(CustomerRow.is_deleted)))",
    );
    // The import line narrows to include and_ and not_ alongside select.
    expect(repo).toContain("from sqlalchemy import and_, not_, select");
  });

  it("emits no capability predicate when the aggregate has no filter (byte-identical guard)", async () => {
    // Regression guard: a future change that always-wraps the read sites would
    // be caught here — the no-filter path must stay exactly as it was.
    const repo = (
      await build(`
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Plain ids guid {
        name: string
      }
      repository Plains for Plain {
        find byName(n: string): Plain[] where name == n
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: python, contexts: [Sales], dataSources: [salesState], serves: SalesApi, port: 4000 }
}
`)
    ).get("api/app/db/repositories/plain_repository.py")!;
    expect(repo).toBeDefined();

    // all() stays a bare select with no capability `.where(`.
    expect(repo).toContain(
      "rows = (await self._session.execute(select(PlainRow))).scalars().all()",
    );
    // No `and_(` / `not_(` conjunction anywhere — no capability filter was emitted.
    expect(repo).not.toContain("and_(");
    expect(repo).not.toContain("not_(");
  });
});
