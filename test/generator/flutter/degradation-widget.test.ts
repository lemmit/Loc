// A DEGRADATION sentinel must stay a WIDGET.
//
// `flutterTarget.renderComment` spells the walker's give-up marker as `const
// SizedBox.shrink() /* … */` — a comment alone is not a legal Dart child, and
// Flutter children are comma-separated list elements.  The pack's raw-text-vs-
// widget probes (`asWidget` / `asText` / `styledText`) matched a constructor
// call `Foo(…)` but NOT the leading `const `, so every slot they guard wrapped
// the sentinel in `Text('…')` — and the running app PRINTED Dart source on
// screen (a table cell, a tab body, a Card child, a KeyValueRow slot).
//
// These pin the widget-vs-text discrimination at those slots.  No Dart is
// compiled here; `generated-flutter-build.yml` owns the SDK gate.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// `viaStore` is a page `derived` over a STORE field — a binding only the page
// shell can name, so the derived stays deferred and every read of it degrades
// to the sentinel.  That gives one deterministic degraded value to feed into a
// table cell, a tab body and a Card child at once.
const SRC = `
system Shop {
  subdomain Sales { context Orders {
    aggregate Product { name: string  price: money }
    repository Products for Product { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    framework: flutter
    api Shop: ShopApi
    store Cart { state { count: int = 0 } }
    page List {
      route: "/products"
      derived viaStore: int = Cart.count + 1
      body: Stack {
        QueryView { of: Shop.Product.all,
          loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" },
          data: rows => Table(Column("Name", p => p.name), Column("Extra", p => Text { viaStore }), rows: rows) },
        Tabs { Tab { "One", Text { viaStore } } },
        Card { Text { viaStore } }
      }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

const page = async (): Promise<string> =>
  (await generateSystemFiles(SRC)).get("app/lib/pages/list_page.dart")!;

describe("flutter degradation sentinels stay widgets", () => {
  it("emits a degraded table cell as a widget, not as Dart source inside Text(…)", async () => {
    const dart = await page();
    expect(dart).toContain("DataCell(const SizedBox.shrink() /* ref: viaStore */)");
    expect(dart).not.toContain("DataCell(Text('const SizedBox");
  });

  it("emits a degraded tab body and Card child as widgets too", async () => {
    const dart = await page();
    // Tab body (`TabBarView` children) and Card content ride the same probe.
    expect(dart).toContain(
      "TabBarView(children: <Widget>[ const SizedBox.shrink() /* ref: viaStore */ ])",
    );
    expect(dart).toContain("children: <Widget>[const SizedBox.shrink() /* ref: viaStore */]");
    // Nowhere in the page is a `const `-leading widget stringified.
    expect(dart).not.toContain("Text('const SizedBox");
    expect(dart).not.toMatch(/Text\('const\s/);
  });
});
