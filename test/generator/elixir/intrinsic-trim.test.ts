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
    platform: elixir { foundation: vanilla }
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
          platform: elixir { foundation: vanilla }
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
