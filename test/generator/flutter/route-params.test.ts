// Flutter `:param` routes — the router half of a detail page.
//
// THE BUG THIS PINS.  `MaterialApp.routes` is a map matched by EXACT STRING.
// The emitter registered every page's route TEMPLATE as a key, so a page
// declared `route: "/products/:id"` became the literal key `'/products/:id'` —
// while every link to it pushes a CONCRETE path (`pushNamed('/products/' + id)`
// from `flutterTarget.renderNavigate` and from the `IdLink` table primitive).
// The two never met: the template was a dead key, and every detail link in the
// shipped `web/src/examples/sales-system-flutter.ddd` resolved to no route at
// all.  `flutter analyze` and `flutter build web` are both blind to it — the
// Dart is valid, the app just has no detail pages.
//
// THE FIX.  Templated routes move out of `routes:` into an `onGenerateRoute`
// that matches by segment and hands the captured `:param` values on as the
// route's `arguments` MAP — which is exactly the shape `routeArgBindings`
// already binds a page's `id` from.  `WidgetsApp` consults `routes` FIRST, so a
// literal sibling (`/products/new` beside `/products/:id`) still wins by exact
// match without any hand-ordered precedence.
//
// WHY THIS FILE SITS BESIDE `route-generate.test.ts`.  That file pins the two
// facts the fix is usually described by: a `:param` route resolves through
// `onGenerateRoute`, and a param-free ui emits no router.  The three cases
// here are the ones it does NOT reach, and each is a distinct way the fix can
// regress while still looking right:
//
//   1. the ARGUMENTS CONTRACT — the captured segment has to arrive under the
//      param NAME, because the page shell reads `routeArgs['id']`.  A router
//      that resolves the route but hands on a positional list compiles and
//      routes, and the detail page renders empty.
//   2. LITERAL PRECEDENCE — `/products/new` must keep winning over
//      `/products/:id`.  Regressing this makes the create form unroutable, and
//      no analyzer sees it.
//   3. the ROUND TRIP — the pushed path and the registered template must agree
//      on SHAPE.  This is the actual bug: both halves were individually valid,
//      they just never met.
//
// No Dart is compiled here; `generated-flutter-build.yml` owns that.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** A list page, a literal `/new` sibling, and a `:id` detail page — the
 *  scaffolded CRUD shape, which is where the bug bit. */
const SRC = `
system Mobile {
  subdomain S {
    context Shop {
      aggregate Product { name: string }
      repository Products for Product { }
    }
  }
  api A from S
  ui MobileApp {
    framework: flutter
    api Shop: A
    page List {
      route: "/products"
      body: QueryView { of: Shop.Product.all, data: rows => Table { rows: rows } }
    }
    page New { route: "/products/new" body: CreateForm { of: Product } }
    page Detail {
      route: "/products/:id"
      body: QueryView { of: Shop.Product.byId(id), single: true, data: p => Text { p.name } }
    }
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

/** The SCAFFOLDED shape — what every shipped Flutter example actually emits
 *  (`ui WebApp with scaffold(…)`), where the `:id` detail route and the
 *  `IdLink` that pushes into it are both macro-generated. */
const SCAFFOLDED = `
system Mobile {
  subdomain S {
    context Shop {
      aggregate Product with crudish { name: string }
      repository Products for Product { }
    }
  }
  api A from S
  ui MobileApp with scaffold(subdomains: [S]) {
    framework: flutter
    api Shop: A
  }
  storage primary { type: postgres }
  resource st { for: Shop, kind: state, use: primary }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: MobileApp { Shop: api1 } port: 3006 }
}
`;

/** Just the `routes: { … }` map — the EXACT-MATCH table.  Sliced out because
 *  the `:id` template legitimately appears elsewhere in the file now (in
 *  `_loomTemplatedRoutes`), and it is only its presence HERE that is the bug. */
function routesBlock(main: string): string {
  const start = main.indexOf("routes: {");
  expect(start, "no `routes: {` block in main.dart").toBeGreaterThan(-1);
  const end = main.indexOf("},", start);
  return main.slice(start, end);
}

const mainOf = async (src: string): Promise<string> => {
  const files = await generateSystemFiles(src);
  const key = [...files.keys()].find((k) => k.endsWith("lib/main.dart"));
  expect(key, `no lib/main.dart in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return files.get(key!)!;
};

describe("flutter `:param` routes", () => {
  it("hands the captured `:param` on under its NAME, as the arguments map the page binds from", async () => {
    // The contract between the two halves.  `_generateRoute` captures the
    // segment; the DETAIL PAGE reads it back by name out of the route's
    // `arguments`.  A router that resolves the route but hands the segment on
    // positionally satisfies `route-generate.test.ts` and still renders an
    // empty detail page, so both ends are asserted here, together.
    const main = await mainOf(SRC);
    expect(main, "the captured segment must be keyed by the param NAME").toContain(
      "<String, String>{'id': segments[1]}",
    );
    expect(main, "…and ride the route as `arguments`").toMatch(
      /settings: RouteSettings\(name: settings\.name, arguments: args\)/,
    );

    // The reader half — `index.ts` `routeArgBindings`.
    const files = await generateSystemFiles(SRC);
    const detail = [...files.entries()].find(([k]) => k.endsWith("detail_page.dart"))![1];
    expect(detail).toContain("final routeArgs = ModalRoute.of(context)?.settings.arguments;");
    expect(detail).toContain("routeArgs['id']");

    // Route params must WIN over any `arguments` a caller passed, so a stale
    // `id` in a pushed argument map cannot shadow the URL. (`...params` last.)
    const spread = main.indexOf("...params,");
    const passed = main.indexOf("if (passed is Map)");
    expect(spread, "no `...params` spread in `_routeTo`").toBeGreaterThan(-1);
    expect(
      spread,
      "route params must be spread AFTER the caller's arguments, so the URL wins",
    ).toBeGreaterThan(passed);
  });

  it("keeps the literal sibling an exact-match `routes:` key, so `/products/new` still wins", async () => {
    // `WidgetsApp` consults `routes` first and only falls through to
    // `onGenerateRoute` on a miss.  If the literal sibling were moved into the
    // matcher too, `/products/new` would parse as the DETAIL page for a record
    // whose id is the string "new" — the create form becomes unroutable, and
    // nothing in the Dart toolchain notices.
    const main = await mainOf(SRC);
    expect(main).toContain("'/products/new': (context) => const NewPage(),");
    expect(main).toContain("'/products': (context) => const ListPage(),");
    expect(
      routesBlock(main),
      "a `:param` template is registered as an exact-match key — no pushed path can equal it",
    ).not.toContain(":id");
  });

  it("the pushed path and the matched route agree on shape", async () => {
    // The actual bug, on the SCAFFOLD (the shape the shipped examples use):
    // both halves were individually valid Dart, they just never met.  The link
    // SITE emits a concrete two-segment path; the matcher accepts exactly that
    // shape.  If either side changes, this pairing is what catches the drift.
    const files = await generateSystemFiles(SCAFFOLDED);
    const list = [...files.entries()].find(([k]) => k.endsWith("product_list_page.dart"))![1];
    expect(list).toContain("pushNamed('/products/' + row.id.toString())");

    const main = [...files.entries()].find(([k]) => k.endsWith("lib/main.dart"))![1];
    expect(main, "the matcher must accept the two-segment path the link pushes").toContain(
      "if (segments.length == 2 && segments[0] == 'products') {",
    );
    expect(main).toContain("_routeTo(settings, const ProductDetailPage(), <String, String>{'id':");
    expect(routesBlock(main)).not.toContain(":id");
  });
});
