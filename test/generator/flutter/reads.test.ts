// Flutter data-reads — QueryView data-bound pages.  Two tiers: the read-provider
// projector (`collectFlutterReads` / `renderReadProviders`) driven directly off
// a lowered+enriched ui (string assertions on the emitted `FutureProvider`s),
// and the end-to-end `generate system` wiring (a QueryView page becomes a
// `ConsumerWidget` that hoists `ref.watch(<var>Provider)` and the pack renders
// the async match via `AsyncValue.when`).  No Dart is compiled here — the local
// Flutter SDK gate (`flutter analyze` + `build web`) was run by hand during
// development and `generated-flutter-build.yml` owns it in CI.

import { describe, expect, it } from "vitest";
import {
  collectFlutterReads,
  renderReadProviders,
} from "../../../src/generator/flutter/reads-emit.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { allContexts } from "../../../src/ir/types/loom-ir.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { parseString } from "../../_helpers/parse.js";

// A ui with a QueryView LIST page (`Shop.Product.all`) and a byId DETAIL page
// (`Shop.Product.byId(id)`, single: true) — the two read shapes this slice wires.
const SRC = `
system Reads {
  subdomain S {
    context Shop {
      aggregate Product { name: string  price: int }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  ui MobileApp {
    framework: flutter
    api Shop: ShopApi

    page ProductList {
      route: "/products"
      body: Stack {
        Heading { "Products", level: 1 },
        QueryView {
          of: Shop.Product.all,
          loading: Loader {},
          error: Alert { "Couldn't load products" },
          empty: Empty { "No products yet." },
          data: rows => Stack {
            For { each: rows, p => Card { title: p.name, Text { p.name } } }
          }
        }
      }
    }

    page ProductDetail {
      route: "/products/:id"
      body: QueryView {
        of: Shop.Product.byId(id),
        single: true,
        loading: Loader {},
        error: Alert { "Couldn't load product" },
        empty: Empty { "Product not found" },
        data: p => Stack {
          Text { p.name },
          KeyValueRow { "Name", p.name }
        }
      }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: ShopApi port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

describe("flutter read-provider projector", () => {
  it("collects a list + byId read off the ui's QueryViews", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const enriched = enrichLoomModel(lowerModel(model));
    const ui = enriched.systems[0]!.uis[0]!;
    const reads = collectFlutterReads(ui, allContexts(enriched));

    const all = reads.find((r) => r.varName === "productAll");
    const byId = reads.find((r) => r.varName === "productById");
    expect(all, `no productAll read in ${JSON.stringify(reads)}`).toBeDefined();
    expect(byId, `no productById read in ${JSON.stringify(reads)}`).toBeDefined();
    expect(all!.single).toBe(false);
    expect(byId!.single).toBe(true);
    expect(all!.aggregate).toBe("Product");
    expect(all!.routePath).toBe("/products");
  });

  it("emits a list FutureProvider that GETs the collection and maps fromJson", async () => {
    const { model } = await parseString(SRC, { validate: false });
    const enriched = enrichLoomModel(lowerModel(model));
    const ui = enriched.systems[0]!.uis[0]!;
    const src = renderReadProviders(collectFlutterReads(ui, allContexts(enriched)));

    // A list read → FutureProvider<List<T>> over http.get, unwrapping the paged
    // envelope's `items` and mapping each element through `Product.fromJson`.
    expect(src).toContain("final productAllProvider = FutureProvider<List<Product>>((ref) async {");
    expect(src).toContain("await http.get(apiUri('/products'))");
    expect(src).toContain("body['items'] as List<dynamic>");
    expect(src).toContain("Product.fromJson(e as Map<String, dynamic>)");

    // A byId read → a `.family<T?, String>` provider keyed on the route id.
    expect(src).toContain(
      "final productByIdProvider = FutureProvider.family<Product?, String>((ref, id) async {",
    );
    expect(src).toContain("await http.get(apiUri('/products/$id'))");
    expect(src).toContain("if (res.statusCode == 404) return null;");
  });
});

describe("flutter QueryView data-bound pages (generate system)", () => {
  it("a QueryView page becomes a ConsumerWidget hoisting ref.watch + AsyncValue.when", async () => {
    const files = await generateSystemFiles(SRC);
    const keys = [...files.keys()];

    // The read providers + api-base config land as their own libraries.
    const reads = keys.find((k) => k.endsWith("app/lib/reads.dart"));
    const config = keys.find((k) => k.endsWith("app/lib/config.dart"));
    expect(reads, `no reads.dart in: ${keys.join(", ")}`).toBeDefined();
    expect(config, `no config.dart in: ${keys.join(", ")}`).toBeDefined();
    expect(files.get(config!)).toContain("String.fromEnvironment('API_BASE_URL'");

    // List page: a ConsumerWidget importing the providers, hoisting the watched
    // AsyncValue, and dispatching on it via `.when` (empty folds into `data:`).
    const list = keys.find((k) => k.endsWith("product_list_page.dart"));
    expect(list, `no product_list_page in: ${keys.join(", ")}`).toBeDefined();
    const listSrc = files.get(list!)!;
    expect(listSrc).toContain("class ProductListPage extends ConsumerWidget");
    expect(listSrc).toContain("import '../reads.dart';");
    expect(listSrc).toContain("final productAll = ref.watch(productAllProvider);");
    expect(listSrc).toContain("productAll.when(loading: () =>");
    expect(listSrc).toContain("data: (productAll) => productAll.isEmpty ?");
    // The `For` row binding types against the model — `.map((p) => …p.name…)`,
    // with NO unused index local.
    expect(listSrc).toContain("...productAll.map((p) =>");
    expect(listSrc).not.toContain("entry.key");

    // Detail page: a byId read binds the route id, watches the `.family`
    // provider, and the single `.when` empties on `null`.
    const detail = keys.find((k) => k.endsWith("product_detail_page.dart"));
    expect(detail, `no product_detail_page in: ${keys.join(", ")}`).toBeDefined();
    const detailSrc = files.get(detail!)!;
    expect(detailSrc).toContain("class ProductDetailPage extends ConsumerWidget");
    expect(detailSrc).toContain("final id = (ModalRoute.of(context)?.settings.arguments");
    expect(detailSrc).toContain("final productById = ref.watch(productByIdProvider(id));");
    expect(detailSrc).toContain("data: (productById) => productById == null ?");
  });
});
