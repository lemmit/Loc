import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 (slice 1) — capability `filter` on a `shape: document` aggregate
// (node / Hono+Drizzle).  A document aggregate stores every field in the `data`
// jsonb column, so the filter can't be a SQL column predicate — it's applied
// in-app over the rehydrated aggregate (the read already deserialises every
// row).  The capability narrows the visible set on every read: findById (→
// not-found when hidden), findManyByIds, the synthesized findAll, and each
// custom find (capability narrows BEFORE the find's own predicate).
// ---------------------------------------------------------------------------

const SOURCE = `
system DocFilter {
  subdomain Sales {
    context Shop {
      aggregate Cart shape: document {
        label: string
        isDeleted: bool
        filter !this.isDeleted
        operation softDelete() { isDeleted := true }
      }
      repository Carts for Cart { find byLabel(l: string): Cart[] where label == l }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: node, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}
`;

async function repo(): Promise<string> {
  const files = await generateSystemFiles(SOURCE);
  const key = [...files.keys()].find((k) => /repositories\/.*cart/i.test(k))!;
  expect(key, "Cart document repository not emitted").toBeDefined();
  return files.get(key!)!;
}

describe("node document capability filter (DEBT-02 slice 1)", () => {
  it("gates findById by the in-app predicate (hidden → not-found)", async () => {
    const r = await repo();
    expect(r).toContain("const rec = cartFromDoc(row.data as CartDoc, row.version);");
    expect(r).toContain("if (!((!rec.isDeleted))) return null;");
    expect(r).toContain("return rec;");
  });

  it("filters findManyByIds by the capability predicate", async () => {
    expect(await repo()).toContain(
      "rows.map((r) => cartFromDoc(r.data as CartDoc, r.version)).filter((x) => (!x.isDeleted));",
    );
  });

  it("narrows findAll/list by the capability predicate", async () => {
    // The synthesized `findAll` has no own predicate → just the capability filter.
    expect(await repo()).toContain(
      "const all = rows.map((r) => cartFromDoc(r.data as CartDoc, r.version));",
    );
    expect(await repo()).toContain("all.filter((x) => (!x.isDeleted))");
  });

  it("applies the capability BEFORE a custom find's own predicate", async () => {
    expect(await repo()).toContain(
      "all.filter((x) => (!x.isDeleted)).filter((x) => x.label === l)",
    );
  });

  it("leaves a filter-free document aggregate's findById byte-identical", async () => {
    const noFilter = SOURCE.replace("        filter !this.isDeleted\n", "");
    const files = await generateSystemFiles(noFilter);
    const key = [...files.keys()].find((k) => /repositories\/.*cart/i.test(k))!;
    const r = files.get(key!)!;
    expect(r).toContain("return cartFromDoc(row.data as CartDoc, row.version);");
    expect(r).not.toContain("const rec =");
  });
});

// ---------------------------------------------------------------------------
// DEBT-02 Slice B — a PRINCIPAL-referencing capability filter
// (`filter this.tenantId == currentUser.tenantId`) on a `shape: document`
// node aggregate.  The principal can't be a static predicate, so each in-app
// document read binds `const currentUser = requireCurrentUser();` (fail-closed
// — throws when unauthenticated) and AND-s the principal predicate over the
// rehydrated aggregate.  Requires `auth: required` + a system `user {}` block.
// ---------------------------------------------------------------------------

const PRINCIPAL_SOURCE = `
system DocTenancy {
  user { id: string  tenantId: string }
  subdomain Sales {
    context Shop {
      aggregate Order shape: document {
        tenantId: string
        code: string
        filter this.tenantId == currentUser.tenantId
        operation rename(code: string) { code := code }
      }
      repository Orders for Order { find byCode(c: string): Order[] where code == c }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: node, contexts: [Shop], dataSources: [shopState], serves: ShopApi, auth: required, port: 4000 }
}
`;

async function principalRepo(): Promise<string> {
  const files = await generateSystemFiles(PRINCIPAL_SOURCE);
  const key = [...files.keys()].find((k) => /repositories\/.*order/i.test(k))!;
  expect(key, "Order document repository not emitted").toBeDefined();
  return files.get(key!)!;
}

describe("node document principal capability filter (DEBT-02 Slice B)", () => {
  it("imports requireCurrentUser from the auth middleware", async () => {
    expect(await principalRepo()).toContain(
      'import { requireCurrentUser } from "../../auth/middleware";',
    );
  });

  it("binds the fail-closed principal in findById and gates the rehydrated aggregate", async () => {
    const r = await principalRepo();
    expect(r).toContain("const currentUser = requireCurrentUser();");
    expect(r).toContain("const rec = orderFromDoc(row.data as OrderDoc, row.version);");
    expect(r).toContain("if (!((rec.tenantId === currentUser.tenantId))) return null;");
  });

  it("binds the principal in findManyByIds and AND-s the in-app predicate", async () => {
    expect(await principalRepo()).toContain(
      "rows.map((r) => orderFromDoc(r.data as OrderDoc, r.version)).filter((x) => (x.tenantId === currentUser.tenantId));",
    );
  });

  it("narrows the synthesized findAll by the principal predicate", async () => {
    const r = await principalRepo();
    expect(r).toContain(
      "const all = rows.map((r) => orderFromDoc(r.data as OrderDoc, r.version));",
    );
    expect(r).toContain("all.filter((x) => (x.tenantId === currentUser.tenantId))");
  });

  it("applies the principal capability BEFORE a custom find's own predicate", async () => {
    expect(await principalRepo()).toContain(
      "all.filter((x) => (x.tenantId === currentUser.tenantId)).filter((x) => x.code === c)",
    );
  });
});
