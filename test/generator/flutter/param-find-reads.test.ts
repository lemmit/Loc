// Flutter emits a read provider for a PARAMETERIZED repository find.
//
// `collectFlutterReads` collected only `.all` / `.byId`.  The page walker had no
// such restriction: for `QueryView { of: Shop.Product.byName("x") }` it emitted
//
//     import '../reads.dart';
//     final productByName = ref.watch(productByNameProvider((term: 'x')));
//
// …and the collector produced neither the provider nor the file.  The generated
// Flutter project therefore carried a dangling import and an undefined symbol —
// it would not pass `flutter analyze`.  Surfaced by #2384, which found the
// assertion that should have caught it passing vacuously against a `?? ""`.
//
// The collector's own comment claimed an un-emitted provider "would just be an
// unresolved var, never silent".  True that it isn't silent — but it breaks the
// build, which is not the same as being covered.
//
// WIRE CONTRACT — every value here is read off the EMITTED BACKEND ROUTE, not
// assumed to match `.all`:
//
//   route      GET /<plural(agg)>/<snake(findName)>   (matches the React
//              `useNamedProduct` client and the emitted Hono route)
//   query      the find's declared param names
//   list find  a BARE ARRAY — `.all` is paged-by-default (M-T2.6) and returns
//              `{items: […]}`, but a find is not paged and the route emits
//              `c.json(result.map(toWire))`.  Decoding one as the other throws
//              at runtime, and `flutter analyze` cannot see a wrong JSON shape.
//   single     404 → null, body is the object.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { expectEmitted } from "../../_helpers/emitted.js";

async function build(source: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const syntax = doc.parseResult?.parserErrors ?? [];
  if (syntax.length) throw new Error(`fixture syntax error: ${syntax[0]?.message}`);
  return doc.parseResult?.value as Model;
}

const sys = (finds: string, of: string, data: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Product { name: string }
      repository Products for Product {${finds}}
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  ui WebApp {
    framework: flutter
    api Sales: SalesApi
    page ProductList {
      route: "/products"
      body: QueryView { of: ${of}, data: ${data} }
    }
  }
  deployable api { platform: node, contexts: [Orders], dataSources: [st], serves: SalesApi, port: 3000 }
  deployable web { platform: flutter, targets: api, port: 3001, ui: WebApp { Sales: api } }
}`;

const LIST = sys(
  `
        find byName(term: string): Product[] where this.name == term`,
  'Sales.Product.byName("x")',
  "rows => Stack { For { each: rows, r => Text { r.name } } }",
);

const SINGLE = sys(
  `
        find oneByName(t: string): Product? where this.name == t`,
  'Sales.Product.oneByName("x")',
  "hit => Text { hit.name }",
);

// The same shape with NO parameters — the branch that shipped invalid Dart.
const NO_PARAMS = sys(
  `
        find inStock(): Product[] where this.name != ""`,
  "Sales.Product.inStock",
  "rows => Stack { For { each: rows, r => Text { r.name } } }",
);

const NO_PARAMS_SINGLE = sys(
  `
        find latest(): Product? where this.name != ""`,
  "Sales.Product.latest",
  "hit => Text { hit.name }",
);

describe("flutter emits a provider for a parameterized find", () => {
  it("list find — .family keyed by a record, bare-array decode, no dangling import", async () => {
    const files = generateSystems(await build(LIST)).files;
    // `expectEmitted`, not `?? ""` — the bug under test IS the file being
    // absent, which `?? ""` would turn into a passing assertion (#2393).
    const reads = expectEmitted(files, "web/lib/reads.dart");
    const page = expectEmitted(files, "web/lib/pages/product_list_page.dart");

    expect(reads).toContain(
      "FutureProvider.family<List<Product>, ({String term})>((ref, q) async {",
    );
    expect(reads).toContain("apiUri('/products/by_name')");
    expect(reads).toContain("'term': '${q.term}',");
    // A find is NOT paged: decode a bare array, never the `{items: …}` envelope.
    expect(reads).toContain("final items = jsonDecode(res.body) as List<dynamic>;");
    expect(reads).not.toContain("body['items']");

    // The call site the walker emits must match the provider's key type.
    expect(page).toContain("ref.watch(productByNameProvider((term: 'x')))");
    expect(page).toContain("import '../reads.dart';");
  });

  it("single-record find — nullable family, 404 → null, object decode", async () => {
    const files = generateSystems(await build(SINGLE)).files;
    const reads = expectEmitted(files, "web/lib/reads.dart");

    expect(reads).toContain("FutureProvider.family<Product?, ({String t})>((ref, q) async {");
    expect(reads).toContain("apiUri('/products/one_by_name')");
    expect(reads).toContain("if (res.statusCode == 404) return null;");
    expect(reads).toContain(
      "return Product.fromJson(jsonDecode(res.body) as Map<String, dynamic>);",
    );
  });

  // A find with NO params is still a named find, so it took the `.family`
  // branch — whose key type is a Dart RECORD of the params.  With none that
  // spelled the empty record as `({})`; Dart writes it `()`, so `reads.dart`
  // did not parse and every page watching the provider cascaded (#2433).
  //
  // A key with no fields is not a key at all, so the fix is a PLAIN
  // `FutureProvider` — which is what the call site was already emitting
  // (`renderApiHoisting` watches the bare `<var>Provider` when a read renders
  // no args), so emitter and call site had silently disagreed all along.
  it("parameterless list find — a plain FutureProvider, never an empty record key", async () => {
    const files = generateSystems(await build(NO_PARAMS)).files;
    const reads = expectEmitted(files, "web/lib/reads.dart");
    const page = expectEmitted(files, "web/lib/pages/product_list_page.dart");

    expect(reads).toContain("final productInStockProvider = FutureProvider<List<Product>>((ref)");
    expect(reads).not.toContain("({})");
    expect(reads).not.toContain("FutureProvider.family<List<Product>, ({})>");
    // No params means no query string to build.
    expect(reads).toContain("await http.get(apiUri('/products/in_stock'))");
    // Still a find, so still a BARE array — not the paged `.all` envelope.
    expect(reads).toContain("as List<dynamic>;");
    expect(reads).not.toContain("body['items']");
    // …and the bare watch the walker emits resolves to it.
    expect(page).toContain("ref.watch(productInStockProvider)");
    expect(page).not.toContain("productInStockProvider(");
  });

  it("parameterless single find — a plain nullable FutureProvider, 404 → null", async () => {
    const reads = expectEmitted(
      generateSystems(await build(NO_PARAMS_SINGLE)).files,
      "web/lib/reads.dart",
    );
    expect(reads).toContain("final productLatestProvider = FutureProvider<Product?>((ref)");
    expect(reads).not.toContain("({})");
    expect(reads).toContain("if (res.statusCode == 404) return null;");
  });

  it("every provider the page watches is actually emitted", async () => {
    for (const src of [LIST, SINGLE]) {
      const files = generateSystems(await build(src)).files;
      const reads = expectEmitted(files, "web/lib/reads.dart");
      const page = expectEmitted(files, "web/lib/pages/product_list_page.dart");
      // The generalised form of the bug: any `<x>Provider` the page watches must
      // be declared in reads.dart, or the project does not analyze.
      for (const m of page.matchAll(/ref\.watch\((\w+Provider)/g)) {
        expect(reads, `page watches ${m[1]} but reads.dart does not declare it`).toContain(
          `final ${m[1]} =`,
        );
      }
    }
  });
});
