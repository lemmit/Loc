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
      aggregate Customer {
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
      aggregate Plain {
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

// ---------------------------------------------------------------------------
// shape(embedded) capability filters (DEBT-02 tail).  An embedded aggregate's
// root scalars are real columns, so the predicate AND-s into the embedded SQL
// reads exactly like the relational path — `repository-embedded-builder.ts`
// threads the SAME `contextFilterPredicate`.  Both the non-principal and the
// principal (`require_current_user()`) cases are wired; only `shape(document)`
// stays gated (in-app filtering, not built).
// ---------------------------------------------------------------------------

const EMBED_REPO = "api/app/db/repositories/cart_repository.py";

describe("python generator — capability filter on shape(embedded)", () => {
  it("AND-s a NON-PRINCIPAL filter into every embedded root read", async () => {
    const repo = (
      await build(`
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Cart shape(embedded) {
        total: int
        archived: bool
        filter !this.archived
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: python, contexts: [Sales], dataSources: [salesState], serves: SalesApi, port: 4000 }
}
`)
    ).get(EMBED_REPO)!;
    expect(repo).toBeDefined();
    // all(): bare predicate.
    expect(repo).toContain("select(CartRow).where(not_(CartRow.archived))");
    // find_by_id: switched off the `session.get` PK fast-path to a filtered select.
    expect(repo).toContain("select(CartRow).where(and_(CartRow.id == id, not_(CartRow.archived)))");
    // find_many_by_ids: in_() AND-ed with the filter.
    expect(repo).toContain(
      "select(CartRow).where(and_(CartRow.id.in_(list(ids)), not_(CartRow.archived)))",
    );
    expect(repo).toContain("from sqlalchemy import and_, not_, select");
  });

  it("renders a PRINCIPAL filter against require_current_user() on an embedded aggregate", async () => {
    const repo = (
      await build(`
system Shop {
  user { id: string  tenantId: string }
  subdomain Sales {
    context Sales {
      aggregate Cart shape(embedded) {
        total: int
        tenantId: string
        filter this.tenantId == currentUser.tenantId
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: python, contexts: [Sales], dataSources: [salesState], serves: SalesApi, auth: required, port: 4000 }
}
`)
    ).get(EMBED_REPO)!;
    expect(repo).toBeDefined();
    // The principal claim renders against the ambient accessor — no read-method param.
    expect(repo).toContain("(CartRow.tenant_id == require_current_user().tenant_id)");
    expect(repo).toContain("from app.auth.user import require_current_user");
    // AND-ed into the id-scoped find_by_id read.
    expect(repo).toContain(
      "select(CartRow).where(and_(CartRow.id == id, (CartRow.tenant_id == require_current_user().tenant_id)))",
    );
  });

  it("keeps the embedded no-filter path byte-identical (session.get fast-path)", async () => {
    const repo = (
      await build(`
system Shop {
  subdomain Sales {
    context Sales {
      aggregate Cart shape(embedded) {
        total: int
        archived: bool
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg }
  deployable api { platform: python, contexts: [Sales], dataSources: [salesState], serves: SalesApi, port: 4000 }
}
`)
    ).get(EMBED_REPO)!;
    expect(repo).toBeDefined();
    // No filter → find_by_id keeps the cheap primary-key get, no capability where.
    expect(repo).toContain("row = await self._session.get(CartRow, id)");
    expect(repo).toContain("rows = (await self._session.execute(select(CartRow))).scalars().all()");
    expect(repo).not.toContain("and_(");
    expect(repo).not.toContain("not_(");
  });
});
