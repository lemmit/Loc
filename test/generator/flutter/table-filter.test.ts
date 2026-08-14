// Flutter `Table(filter: <state>)` — the `renderFilterInput` /
// `renderFilteredRows` WalkerTarget seams (M-T1.1 client column filter).
//
// `primitives/table.ts` activates the filter only when the target implements
// BOTH seams; Flutter had neither, so a `filter:` arg was silently dropped — no
// search box, and the state cell it named went unread while every other frontend
// (react/vue/svelte/angular/feliz) filtered.  The advice the DSL gives ("use
// Table, it filters everywhere") was untrue on this target.
//
// These pin the emitted SHAPE.  The runtime half (typing into the box actually
// narrows the rows) is Flutter-test territory, like the sort/pager controls in
// `table-controls.test.ts`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (table: string) => `
system Shop {
  subdomain Sales { context Orders {
    aggregate Product { name: string  sku: string  price: int }
    repository Products for Product { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    api Shop: ShopApi
    page List { route: "/products"
      state { q: string = "" }
      body: QueryView { of: Shop.Product.all, data: rows => ${table} } }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

const FILTERED = `Table(
  Column("Name", p => p.name), Column("SKU", p => p.sku),
  rows: rows, filter: q)`;

const page = async (table = FILTERED): Promise<string> =>
  (await generateSystemFiles(SYS(table))).get("app/lib/pages/list_page.dart")!;

describe("flutter Table filter (M-T1.1)", () => {
  it("emits a Material search box bound to the filter state cell", async () => {
    const dart = await page();
    expect(dart).toContain("TextField(decoration: const InputDecoration(");
    expect(dart).toContain("prefixIcon: Icon(Icons.search)");
    expect(dart).toContain("onChanged: (value) => notifier.setQ(value)");
    // The shell must bind the `notifier` the box writes through, and the `state`
    // the rows expression reads — Dart has no hoisting, so an unbound name here
    // is a hard `Undefined name`.
    expect(dart).toContain("final state = ref.watch(listProvider);");
    expect(dart).toContain("final notifier = ref.read(listProvider.notifier);");
  });

  it("narrows the rows by a case-insensitive substring over the declared columns", async () => {
    const dart = await page();
    expect(dart).toContain("final __q = state.q.trim().toLowerCase();");
    // Dart records have no runtime value enumeration, so the searchable set is
    // the columns the table displays — both of them, in declaration order.
    expect(dart).toContain("<Object?>[row.name, row.sku]");
    expect(dart).toContain("v.toString().toLowerCase().contains(__q)");
    // An empty query passes every row (same contract as the JS targets).
    expect(dart).toContain("__q.isEmpty ||");
    expect(dart).toContain(".where((row) {");
    expect(dart).toContain("}).toList()");
  });

  it("emits no JavaScript idioms", async () => {
    const dart = await page();
    // The JS default the four markup targets share — `Object.values(row)`,
    // `String(v)`, `.includes`, `===` — is what a target without these seams
    // would have leaked into a `.dart` file.
    for (const js of ["Object.values", "String(v)", "===", "!==", ".includes(", ".filter((r)"]) {
      expect(dart).not.toContain(js);
    }
  });

  it("keeps the widget tree balanced", async () => {
    const dart = await page();
    const count = (re: RegExp) => (dart.match(re) ?? []).length;
    expect(count(/\(/g)).toBe(count(/\)/g));
    expect(count(/\[/g)).toBe(count(/\]/g));
    expect(count(/\{/g)).toBe(count(/\}/g));
    // The filter box and the table are siblings, so the table went multi-root —
    // Dart has no fragment, so `joinRoots` must have wrapped them in a Column.
    expect(dart).toContain(
      "Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[TextField(",
    );
  });

  it("leaves a filter-less Table byte-identical", async () => {
    const plain = await page(`Table(Column("Name", p => p.name), rows: rows)`);
    expect(plain).not.toContain("TextField(");
    expect(plain).not.toContain(".where((row)");
  });

  it("passes the rows through when no column resolves to a plain member", async () => {
    // Every accessor is a computed cell, so there is no row property to search:
    // filtering on nothing would silently empty the table.
    const dart = await page(`Table(Column("Name", p => Badge(p.name)), rows: rows, filter: q)`);
    expect(dart).toContain("TextField(");
    expect(dart).not.toContain("<Object?>[]");
    expect(dart).not.toContain(".where((row) {");
  });
});
