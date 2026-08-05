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
        find maybeFirst(sku: string): Item option where this.sku == sku
        find named(name: string): Item[] where this.name == name
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
    // The absent arm now maps to the shared 404 ProblemDetails responder, with
    // the canonical `"not_found"` TOKEN as `detail`.
    //
    // RETITLED 2026-08-05.  This used to pin `"Item not found"` — a sentence
    // that reads like RS-27's by-id form but carries no id and matched no other
    // backend (node/python/java/dotnet all send `"not_found"`; RS-27 scopes the
    // find miss OUT of the sentence and keeps the token).  Elixir had TWO
    // spellings for one 404 in one controller: this arm interpolated the
    // aggregate, and the `T option` arm below said `"Not Found"` (its
    // `problem_variant/5` helper sets `detail: title`).  Both now reach the
    // shared producer with the same token — this rule's own lesson, applied to
    // the arms that never reached it.  Found by the caller-census drain, whose
    // first callers for `by_email`/`by_reference`/`by_code`/`by_sku` surfaced it
    // as 9 of the elixir leg's 11 wire divergences.
    expect(ctrl).toContain(
      '        ProblemDetails.problem_response(conn, 404, "Not Found", "not_found")',
    );
    // Neither old spelling may come back.
    expect(ctrl).not.toContain('"Item not found"');
    expect(ctrl).not.toContain('problem_variant(conn, 404, "about:blank", "Not Found", %{})');
    // BOTH absence shapes go through the SAME producer — `T?` and `T option`
    // are wire-identical per docs/payloads.md, so two calls, one spelling.
    expect(
      ctrl!.match(/ProblemDetails\.problem_response\(conn, 404, "Not Found", "not_found"\)/g)
        ?.length,
    ).toBe(2);
    // …and the by_sku action no longer emits the schema-invalid 200 null body.
    const bySku = ctrl!.slice(ctrl!.indexOf("def by_sku"), ctrl!.indexOf("def by_sku") + 260);
    expect(bySku).not.toContain("{:ok, nil} -> json(conn, nil)");
    // The success arm still serializes the found record (now multi-line).
    expect(bySku).toContain("{:ok, record} ->");
    expect(bySku).toContain("json(conn, serialize(record))");
  });

  it("a LIST find is untouched — it has no absence to answer", async () => {
    // Scope guard: `Item[]` answers `[]`, never a 404 (RS-23).  Without this a
    // fix that 404'd every nil-ish find would pass the assertions above.
    const files = await generateSystemFiles(SOURCE);
    const ctrl = [...files.entries()].find(([p]) => p.endsWith("item_controller.ex"))?.[1];
    const named = ctrl!.slice(ctrl!.indexOf("def named"));
    const body = named.slice(
      0,
      named.indexOf("\n  def ", 1) === -1 ? undefined : named.indexOf("\n  def ", 1),
    );
    expect(body).toContain("json(conn,");
    expect(body).not.toContain("problem_response");
  });
});
