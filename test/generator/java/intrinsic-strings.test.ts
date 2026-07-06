// A2 string batch of the scalar-intrinsic catalogue (docs/plans/stdlib.md)
// on the Java/Spring backend — in-memory rendering in derived bodies,
// JPQL rendering for the queryable rows (toUpper/toLower) in a
// `find … where` position, and the Criteria/Specification path for a
// reified criterion.  Catalogue rows in src/util/intrinsics.ts; Java
// snippets in render-expr.ts (JAVA_INTRINSIC_RENDERERS), render-jpql.ts
// (JPQL_INTRINSIC_SQL), render-criteria.ts (JAVA_CRITERIA_INTRINSICS).
// Sibling of the trim pilot (intrinsic-trim.test.ts).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Shop {
  subdomain Sales {
    context Catalog {
      aggregate Product {
        name: string
        derived slug: string = name.trim().toLower()
      }
      repository Products for Product {
        find byNameCi(q: string): Product[] where this.name.toLower() == q
      }
    }
  }
  api CatalogApi from Sales
  storage primary { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: primary }
  deployable shopApi {
    platform: java
    contexts: [Catalog]
    dataSources: [catalogState]
    serves: CatalogApi
    port: 8081
  }
}
`;

const ROOT = "shop_api/src/main/java/com/loom/shopapi";

describe("java generator — string intrinsics batch (stdlib A2)", () => {
  it("parses + validates cleanly (chained trim().toLower(), queryable where)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders a chained trim().toLower() in-memory in the derived body", async () => {
    const files = await generateSystemFiles(SRC);
    const domain = files.get(`${ROOT}/features/products/Product.java`)!;
    expect(domain).toContain("this.name.trim().toLowerCase(java.util.Locale.ROOT)");
  });

  it("renders toLower as JPQL lower() in the find where-clause (column side)", async () => {
    const files = await generateSystemFiles(SRC);
    const jpa = files.get(`${ROOT}/features/products/ProductJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Product e where lower(e.name) = :q")');
  });

  it("renders toUpper as JPQL upper() (value side too — works on parameters)", async () => {
    const src = SRC.replace(
      "find byNameCi(q: string): Product[] where this.name.toLower() == q",
      "find byNameUc(q: string): Product[] where this.name.toUpper() == q.toUpper()",
    );
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
    const files = await generateSystemFiles(src);
    const jpa = files.get(`${ROOT}/features/products/ProductJpaRepository.java`)!;
    expect(jpa).toContain('@Query("select e from Product e where upper(e.name) = upper(:q)")');
  });

  it("renders toLower in a reified criterion Specification via cb.lower", async () => {
    const src = SRC.replace(
      "repository Products for Product {",
      `criterion NamedCi(q: string) of Product = name.toLower() == q
      repository Products for Product {`,
    );
    const { errors } = await parseString(src);
    expect(errors).toEqual([]);
    const files = await generateSystemFiles(src);
    const crit = files.get(`${ROOT}/domain/criteria/ProductCriteria.java`)!;
    expect(crit).toContain('cb.equal(cb.lower(root.<String>get("name")), q)');
  });
});
