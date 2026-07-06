// A1 pilot for the scalar-intrinsic catalogue (docs/plans/stdlib.md):
// `string.trim()` end-to-end on the Elixir/Phoenix (vanilla Ecto) backend —
// in-memory rendering in domain-evaluated bodies AND SQL-fragment rendering in
// a queryable `find … where` position.  The catalogue row lives in
// src/util/intrinsics.ts; the in-memory snippet in render-expr.ts
// (ELIXIR_INTRINSIC_RENDERERS → `String.trim(...)`); the Ecto where-fragment in
// the same file (ECTO_INTRINSIC_FRAGMENTS → `fragment("btrim(?)", ...)`).
// The Elixir sibling of test/generator/typescript/intrinsic-trim.test.ts.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
system Shop {
  subdomain Core {
    context Catalog {
      aggregate Product with crudish {
        name: string
        derived cleanName: string = name.trim()
        invariant name.trim().length > 0
      }
      repository Products for Product {
        find byExactName(q: string): Product[] where this.name.trim() == q
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource st { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Catalog]
    dataSources: [st]
    serves: CatalogApi
    port: 4000
  }
}
`;

async function load(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("elixir generator — string.trim() intrinsic (stdlib A1 pilot)", () => {
  it("parses + validates cleanly (typed as string, queryable where)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders trim in-memory via String.trim (derived wire projection)", async () => {
    const files = await load();
    // The derived's expression is rendered by the shared in-memory renderer in
    // the controller's wireShape-driven serialize/1 (wire-serialize.ts).
    const ctrl = fileEndingWith(files, "/controllers/product_controller.ex");
    expect(ctrl).toContain("String.trim(");
    expect(ctrl).toContain('"cleanName" => String.trim(record.name)');
    // Never the invalid method-call fallthrough (Elixir strings have no methods).
    expect(ctrl).not.toContain(".trim()");
  });

  it("renders trim as a SQL fragment in the find where-clause", async () => {
    const files = await load();
    const repo = fileEndingWith(files, "/product_repository.ex");
    expect(repo).toContain('fragment("btrim(?)"');
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("btrim(?)", record.name) == ^q)',
    );
    expect(repo).not.toContain(".trim()");
  });

  it("renders a value-side trim (param receiver) as a fragment over the pinned param", async () => {
    const files = await generateSystemFiles(`
      system Shop {
        subdomain Core {
          context Catalog {
            aggregate Product with crudish { name: string }
            repository Products for Product {
              find byName(q: string): Product[] where this.name == q.trim()
            }
          }
        }
        api CatalogApi from Core
        storage pg { type: postgres }
        resource st { for: Catalog, kind: state, use: pg }
        deployable api {
          platform: elixir
          contexts: [Catalog]
          dataSources: [st]
          serves: CatalogApi
          port: 4000
        }
      }
    `);
    // Inside an Ecto `where:` the value side is still query territory — a
    // `String.trim(^q)` call would be invalid there, so the fragment form
    // applies to a pinned param receiver too.
    const repo = fileEndingWith(files, "/product_repository.ex");
    expect(repo).toContain('record.name == fragment("btrim(?)", ^q)');
  });
});

// A2 string batch — chained intrinsics in-memory + the queryable toLower in a
// find where-clause (SQL lower() fragment).
const A2_SRC = `
system Shop {
  subdomain Core {
    context Catalog {
      aggregate Product with crudish {
        name: string
        derived slug: string = name.trim().toLower()
      }
      repository Products for Product {
        find byNameCi(q: string): Product[] where this.name.toLower() == q
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource st { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Catalog]
    dataSources: [st]
    serves: CatalogApi
    port: 4000
  }
}
`;

describe("elixir generator — string intrinsics batch (stdlib A2)", () => {
  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(A2_SRC);
    expect(errors).toEqual([]);
  });

  it("renders a chained trim().toLower() derived in-memory via nested String.* calls", async () => {
    const files = await generateSystemFiles(A2_SRC);
    const ctrl = fileEndingWith(files, "/controllers/product_controller.ex");
    expect(ctrl).toContain('"slug" => String.downcase(String.trim(record.name))');
    // Never the invalid method-call fallthroughs.
    expect(ctrl).not.toContain(".trim()");
    expect(ctrl).not.toContain(".to_lower(");
  });

  it("renders toLower as a SQL lower() fragment in the find where-clause", async () => {
    const files = await generateSystemFiles(A2_SRC);
    const repo = fileEndingWith(files, "/product_repository.ex");
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("lower(?)", record.name) == ^q)',
    );
    expect(repo).not.toContain("String.downcase(");
  });
});

// A3 math batch — abs/min/max on int/long/decimal/money + round/floor/ceil on
// decimal/money.  int/long are native integers (Kernel abs/min/max); decimal
// AND money both map to the Decimal struct, so their arms go through
// Decimal.* — `:half_up` IS half-away-from-zero (verified against decimal
// 3.1.1, the version ecto_sql resolves).  In queryable positions everything
// renders as a SQL fragment (Kernel `abs/1` etc. are not Ecto query exprs).
const A3_SRC = `
system Shop {
  subdomain Core {
    context Catalog {
      aggregate Product with crudish {
        qty: int
        rate: decimal
        amount: money
        derived absQty: int = qty.abs()
        derived qtyFloor: int = qty.max(0)
        derived qtyCap: int = qty.min(100)
        derived absAmount: money = amount.abs()
        derived rateRounded: decimal = rate.round(2)
        derived rateWhole: decimal = rate.round()
        derived amountDown: money = amount.floor()
        derived rateUp: decimal = rate.ceil()
        derived amountLo: money = amount.min(amount)
      }
      repository Products for Product {
        find byRoundedRate(q: decimal): Product[] where this.rate.round(2) == q
        find byWholeRate(q: decimal): Product[] where this.rate.round() == q
        find byAbsQty(q: int): Product[] where this.qty.abs() == q
        find byMinCap(cap: money): Product[] where this.amount.min(cap) == cap
        find byMaxQty(q: int): Product[] where this.qty.max(q) == q
        find byFloorAmount(q: money): Product[] where this.amount.floor() == q
        find byCeilRate(q: decimal): Product[] where this.rate.ceil() == q
      }
    }
  }
  api CatalogApi from Core
  storage pg { type: postgres }
  resource st { for: Catalog, kind: state, use: pg }
  deployable api {
    platform: elixir
    contexts: [Catalog]
    dataSources: [st]
    serves: CatalogApi
    port: 4000
  }
}
`;

describe("elixir generator — numeric intrinsics batch (stdlib A3)", () => {
  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(A3_SRC);
    expect(errors).toEqual([]);
  });

  it("renders round in-memory via Decimal.round/:half_up — with and without places", async () => {
    const files = await generateSystemFiles(A3_SRC);
    const ctrl = fileEndingWith(files, "/controllers/product_controller.ex");
    expect(ctrl).toContain('"rateRounded" => Decimal.round(record.rate, 2, :half_up)');
    // Omitted places defaults to 0 (whole-value commercial rounding).
    expect(ctrl).toContain('"rateWhole" => Decimal.round(record.rate, 0, :half_up)');
    // Never the invalid method-call fallthrough.
    expect(ctrl).not.toContain(".round()");
  });

  it("renders abs in-memory — Decimal.abs on money, Kernel abs on int", async () => {
    const files = await generateSystemFiles(A3_SRC);
    const ctrl = fileEndingWith(files, "/controllers/product_controller.ex");
    expect(ctrl).toContain('"absAmount" => Decimal.abs(record.amount)');
    expect(ctrl).toContain('"absQty" => abs(record.qty)');
  });

  it("renders min/max in-memory — Kernel min/max on int, Decimal.min on money", async () => {
    const files = await generateSystemFiles(A3_SRC);
    const ctrl = fileEndingWith(files, "/controllers/product_controller.ex");
    expect(ctrl).toContain('"qtyCap" => min(record.qty, 100)');
    expect(ctrl).toContain('"qtyFloor" => max(record.qty, 0)');
    expect(ctrl).toContain('"amountLo" => Decimal.min(record.amount, record.amount)');
  });

  it("renders floor/ceil in-memory via Decimal.round modes (receiver-typed whole values)", async () => {
    const files = await generateSystemFiles(A3_SRC);
    const ctrl = fileEndingWith(files, "/controllers/product_controller.ex");
    expect(ctrl).toContain('"amountDown" => Decimal.round(record.amount, 0, :floor)');
    expect(ctrl).toContain('"rateUp" => Decimal.round(record.rate, 0, :ceiling)');
  });

  it("renders queryable ops as SQL fragments in the find where-clause", async () => {
    const files = await generateSystemFiles(A3_SRC);
    const repo = fileEndingWith(files, "/product_repository.ex");
    // round — with places (two-hole fragment) and without (single-hole).
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("round(?, ?)", record.rate, 2) == ^q)',
    );
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("round(?)", record.rate) == ^q)',
    );
    // min/max against a pinned param → least()/greatest() (args arrive with
    // the `^` pin already applied by the arg renderer — no extra pinning).
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("least(?, ?)", record.amount, ^cap) == ^cap)',
    );
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("greatest(?, ?)", record.qty, ^q) == ^q)',
    );
    expect(repo).toContain('fragment("floor(?)", record.amount)');
    expect(repo).toContain('fragment("ceil(?)", record.rate)');
    // Never the in-memory Decimal.* forms inside an Ecto query.
    expect(repo).not.toContain("Decimal.round(");
    expect(repo).not.toContain("Decimal.min(");
  });

  it("renders int abs in filter position as the fragment, not Kernel abs", async () => {
    const files = await generateSystemFiles(A3_SRC);
    const repo = fileEndingWith(files, "/product_repository.ex");
    expect(repo).toContain(
      'from(record in Api.Catalog.Product, where: fragment("abs(?)", record.qty) == ^q)',
    );
    expect(repo).not.toMatch(/where: abs\(/);
  });
});
