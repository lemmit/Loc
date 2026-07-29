import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// vanilla Phoenix — an OPTIONAL find (`: X?` / `: X option`) that matches no
// row returns 404, not an HTTP 200 with a `null` body.
//
// `findOptional` declares `[404]` in the shared OpenAPI matrix
// (src/ir/util/openapi-errors.ts), and every other backend returns 404 on
// absence (node throws → 404, .NET NotFound(), python/java 404-at-route).  The
// elixir controller previously emitted `{:ok, nil} -> json(conn, nil)` — a 200
// with a `null` body that isn't a valid `<Agg>Response` (the 200 schema), the
// lone cross-backend divergence for optional-find absence.  A bare `: X` single
// find (findSingle, which declares no error status) keeps its shape — that
// default is the separate (softened) exception-less A4 question.
// ---------------------------------------------------------------------------

const SOURCE = `
system Shop {
  subdomain Sales {
    context Catalog {
      aggregate Item with crudish {
        name: string
        sku: string
      }
      repository Items for Item {
        find bySku(sku: string): Item? where this.sku == sku
      }
    }
  }
  api CatalogApi from Sales
  storage pg { type: postgres }
  resource s { for: Catalog, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Catalog], dataSources: [s], port: 4000 }
}
`;

describe("vanilla Phoenix — optional find absence → 404", () => {
  it("an optional find returns a 404 ProblemDetails on {:ok, nil}, not a 200 null body", async () => {
    const files = await generateSystemFiles(SOURCE);
    const ctrl = [...files.entries()].find(([p]) => p.endsWith("item_controller.ex"))?.[1];
    expect(ctrl).toBeDefined();
    // The absent arm now maps to the shared 404 ProblemDetails responder…
    expect(ctrl).toContain(
      '        ProblemDetails.problem_response(conn, 404, "Not Found", "Item not found")',
    );
    // …and the by_sku action no longer emits the schema-invalid 200 null body.
    const bySku = ctrl!.slice(ctrl!.indexOf("def by_sku"), ctrl!.indexOf("def by_sku") + 260);
    expect(bySku).not.toContain("{:ok, nil} -> json(conn, nil)");
    // The success arm still serializes the found record (now multi-line).
    expect(bySku).toContain("{:ok, record} ->");
    expect(bySku).toContain("json(conn, serialize(record))");
  });
});
