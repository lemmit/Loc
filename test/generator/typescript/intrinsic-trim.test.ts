// A1 pilot for the scalar-intrinsic catalogue (docs/old/plans/stdlib.md):
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
    aggregate Product {
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
        aggregate Product { name: string }
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

describe("typescript generator — A2 string intrinsics end-to-end", () => {
  const SRC2 = `
    context Catalog {
      aggregate Product {
        name: string
        derived slug: string = name.trim().toLower()
        derived initial: string = name.substring(0, 1).toUpper()
        derived tagCount: int = name.split(",").count
      }
      repository Products for Product {
        find byNameCi(q: string): Product[] where this.name.toLower() == q.toLower()
      }
    }
  `;

  it("parses + validates cleanly and renders chained intrinsics in-memory", async () => {
    const { model, errors } = await parseString(SRC2);
    expect(errors).toEqual([]);
    const domain = generateHono(model).get("domain/product.ts")!;
    expect(domain).toContain("this._name.trim().toLowerCase()");
    expect(domain).toContain("this._name.slice(0, (0) + (1)).toUpperCase()");
    expect(domain).toContain('this._name.split(",").length');
  });

  it("renders toLower on BOTH sides of a where (column SQL + value JS)", async () => {
    const { model } = await parseString(SRC2);
    const repo = generateHono(model).get("db/repositories/product-repository.ts")!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source that interpolates the schema column in the generated sql tag, not here
    expect(repo).toContain("eq(sql`lower(${schema.products.name})`, q.toLowerCase())");
  });
});

describe("typescript generator — A3 math intrinsics end-to-end", () => {
  const SRC3 = `
    context Billing {
      aggregate Invoice {
        qty: int
        amount: decimal
        price: money
        derived absQty: int = qty.abs()
        derived rounded: decimal = amount.round(2)
        derived whole: decimal = amount.floor()
        derived cappedPrice: money = price.min(price.round()).max(price.ceil().abs())
      }
      repository Invoices for Invoice {
        find pricier(m: money): Invoice[] where this.price.round(2) > m
        find qtyNear(n: int): Invoice[] where this.qty.abs() == n.abs()
        find capped(a: decimal): Invoice[] where this.amount.min(a) == a
      }
    }
  `;

  it("parses + validates cleanly and renders numerics in-memory", async () => {
    const { model, errors } = await parseString(SRC3);
    expect(errors).toEqual([]);
    const domain = generateHono(model).get("domain/invoice.ts")!;
    // int → Math.*, money → decimal.js Decimal methods.
    expect(domain).toContain("Math.abs(this._qty)");
    expect(domain).toContain(
      "Math.sign(this._amount) * (Math.round(Math.abs(this._amount) * 10 ** (2)) / 10 ** (2))",
    );
    expect(domain).toContain("Math.floor(this._amount)");
    expect(domain).toContain(".toDecimalPlaces(0, Decimal.ROUND_HALF_UP)");
    expect(domain).toContain("Decimal.min(this._price,");
    expect(domain).toContain("Decimal.max(");
    expect(domain).toContain(".ceil().abs()");
  });

  it("renders numeric intrinsics as SQL on the column side of a where", async () => {
    const { model } = await parseString(SRC3);
    const repo = generateHono(model).get("db/repositories/invoice-repository.ts")!;
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source interpolating the schema column in the generated sql tag, not here
    expect(repo).toContain("gt(sql`round(${schema.invoices.price}, ${2})`, m)");
    // Value-side abs (param receiver) stays host JS while the column side is SQL.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source interpolating the schema column in the generated sql tag, not here
    expect(repo).toContain("eq(sql`abs(${schema.invoices.qty})`, Math.abs(n))");
    // Column-side LEAST with a value arg.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: matching emitted source interpolating the schema column in the generated sql tag, not here
    expect(repo).toContain("eq(sql`least(${schema.invoices.amount}, ${a})`, a)");
  });
});
