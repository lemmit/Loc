// A1 pilot for the scalar-intrinsic catalogue (docs/plans/stdlib.md):
// `string.trim()` end-to-end on the Hono backend — in-memory rendering in
// domain bodies AND SQL rendering in a queryable `find … where` position.
// The catalogue row lives in src/util/intrinsics.ts; the TS snippet in
// render-expr.ts (TS_INTRINSIC_RENDERERS); the SQL snippet in
// repository-find-predicate.ts (DRIZZLE_INTRINSIC_SQL).

import { describe, expect, it } from "vitest";
import { generateHono } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
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
`;

describe("typescript generator — string.trim() intrinsic (stdlib A1 pilot)", () => {
  it("parses + validates cleanly (typed as string, queryable where)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders trim in-memory in derived/invariant bodies", async () => {
    const { model } = await parseString(SRC);
    const domain = generateHono(model).get("domain/product.ts")!;
    expect(domain).toContain("this._name.trim()");
  });

  it("renders trim as SQL in the find where-clause and imports `sql`", async () => {
    const { model } = await parseString(SRC);
    const repo = generateHono(model).get("db/repositories/product-repository.ts")!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source that interpolates `${schema.products.name}` in the generated sql tag, not here
    expect(repo).toContain("eq(sql`trim(${schema.products.name})`, q)");
    expect(repo).toMatch(/import \{[^}]*\bsql\b[^}]*\} from "drizzle-orm";/);
  });

  it("renders a value-side trim (param receiver) as plain JS", async () => {
    const src = `
      context Catalog {
        aggregate Product ids guid { name: string }
        repository Products for Product {
          find byName(q: string): Product[] where this.name == q.trim()
        }
      }
    `;
    const { model, errors } = await parseString(src);
    expect(errors).toEqual([]);
    const repo = generateHono(model).get("db/repositories/product-repository.ts")!;
    expect(repo).toContain("eq(schema.products.name, q.trim())");
  });
});
