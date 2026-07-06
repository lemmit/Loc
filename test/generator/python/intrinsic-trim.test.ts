// A1 pilot for the scalar-intrinsic catalogue (docs/plans/stdlib.md):
// `string.trim()` end-to-end on the Python backend — in-memory rendering in
// domain bodies (`.strip()`, NOT the snake-cased fallthrough `.trim()`) AND
// SQL rendering in a queryable `find … where` position (`func.trim(col)`).
// The catalogue row lives in src/util/intrinsics.ts; the Python snippet in
// render-expr.ts (PY_INTRINSIC_RENDERERS); the SQL snippet in
// find-predicate.ts (SQLALCHEMY_INTRINSIC_SQL).  The node analogue is
// test/generator/typescript/intrinsic-trim.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

const DOMAIN = "api/app/domain/product.py";
const REPO = "api/app/db/repositories/product_repository.py";

const SRC = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product ids guid {
        name: string
        derived cleanName: string = name.trim()
        invariant name.trim().length > 0
      }
      repository Products for Product {
        find byExactName(q: string): Product[] where this.name.trim() == q
      }
    }
  }
  api CatalogApi from Catalog
  storage pg { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: pg }
  deployable api { platform: python, contexts: [Catalog], dataSources: [catalogState], serves: CatalogApi, port: 4000 }
}
`;

async function build(source: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(source);
  if (errors.length) throw new Error(`source has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

describe("python generator — string.trim() intrinsic (stdlib A1 pilot)", () => {
  it("parses + validates cleanly (typed as string, queryable where)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders trim in-memory in derived/invariant bodies as .strip()", async () => {
    const domain = (await build(SRC)).get(DOMAIN)!;
    expect(domain).toBeDefined();
    expect(domain).toContain("self._name.strip()");
    // The default fallthrough would snake-case the DSL member onto the
    // receiver — `.trim()` is not a Python string method.  The verbatim DSL
    // source legitimately appears inside error-message string literals
    // (`raise DomainError("Invariant violated: name.trim()…")`), so strip
    // those before asserting no CODE calls `.trim()`.
    const code = domain.replace(/"(?:\\.|[^"\\])*"/g, '""');
    expect(code).not.toContain(".trim(");
  });

  it("renders trim as func.trim(col) in the find where-clause and imports `func`", async () => {
    const repo = (await build(SRC)).get(REPO)!;
    expect(repo).toBeDefined();
    expect(repo).toContain("select(ProductRow).where((func.trim(ProductRow.name) == q))");
    expect(repo).toMatch(/from sqlalchemy import [^\n]*\bfunc\b/);
  });

  it("renders a value-side trim (param receiver) as plain Python .strip()", async () => {
    const src = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product ids guid { name: string }
      repository Products for Product {
        find byName(q: string): Product[] where this.name == q.trim()
      }
    }
  }
  api CatalogApi from Catalog
  storage pg { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: pg }
  deployable api { platform: python, contexts: [Catalog], dataSources: [catalogState], serves: CatalogApi, port: 4000 }
}
`;
    const repo = (await build(src)).get(REPO)!;
    expect(repo).toBeDefined();
    expect(repo).toContain("select(ProductRow).where((ProductRow.name == q.strip()))");
  });
});

// A2 string batch — chained case-mapping in a domain body plus the queryable
// `toLower` in a find where-clause (`func.lower(col)`), mirroring the trim
// pilot above.
describe("python generator — string case intrinsics (stdlib A2)", () => {
  const SRC_A2 = `
system Shop {
  subdomain Catalog {
    context Catalog {
      aggregate Product ids guid {
        name: string
        derived slug: string = name.trim().toLower()
      }
      repository Products for Product {
        find byNameCi(q: string): Product[] where this.name.toLower() == q
      }
    }
  }
  api CatalogApi from Catalog
  storage pg { type: postgres }
  resource catalogState { for: Catalog, kind: state, use: pg }
  deployable api { platform: python, contexts: [Catalog], dataSources: [catalogState], serves: CatalogApi, port: 4000 }
}
`;

  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(SRC_A2);
    expect(errors).toEqual([]);
  });

  it("renders a chained trim().toLower() derived as .strip().lower()", async () => {
    const domain = (await build(SRC_A2)).get(DOMAIN)!;
    expect(domain).toBeDefined();
    expect(domain).toContain("self._name.strip().lower()");
  });

  it("renders toLower as func.lower(col) in the find where-clause and imports `func`", async () => {
    const repo = (await build(SRC_A2)).get(REPO)!;
    expect(repo).toBeDefined();
    expect(repo).toContain("select(ProductRow).where((func.lower(ProductRow.name) == q))");
    expect(repo).toMatch(/from sqlalchemy import [^\n]*\bfunc\b/);
  });
});
