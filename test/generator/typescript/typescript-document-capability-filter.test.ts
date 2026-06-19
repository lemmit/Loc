import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// DEBT-02 (slice 1) — capability `filter` on a `shape(document)` aggregate
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
      aggregate Cart ids guid shape(document) {
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
    expect(r).toContain("const rec = cartFromDoc(row.data as CartDoc);");
    expect(r).toContain("if (!((!rec.isDeleted))) return null;");
    expect(r).toContain("return rec;");
  });

  it("filters findManyByIds by the capability predicate", async () => {
    expect(await repo()).toContain(
      "rows.map((r) => cartFromDoc(r.data as CartDoc)).filter((x) => (!x.isDeleted));",
    );
  });

  it("narrows findAll/list by the capability predicate", async () => {
    // The synthesized `findAll` has no own predicate → just the capability filter.
    expect(await repo()).toContain("const all = rows.map((r) => cartFromDoc(r.data as CartDoc));");
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
    expect(r).toContain("return cartFromDoc(row.data as CartDoc);");
    expect(r).not.toContain("const rec =");
  });
});
