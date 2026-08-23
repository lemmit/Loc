// Flutter `Table` — SERVER-DRIVEN sort + pagination (M-T1.1).
//
// Before this, `sortable:` / `page:` on a Flutter Table were silently dropped:
// the target implemented neither `renderSortableHeader` nor `renderPager`, and
// `primitives/table.ts` degrades to a plain header when the seam is absent.  So
// `loom.datagrid-unsupported-target`'s advice — "use Table, it sorts and pages
// on every frontend" — was untrue on the one target it is shown to most.
//
// These pin the emitted SHAPE.  Whether the controls actually move the state a
// server-paged read is keyed by is proven at runtime by
// `scripts/flutter-table-controls-test.dart`, run against a real generated
// scaffold by `generated-flutter-build.yml` — Flutter web renders to canvas, so
// a DOM smoke is not available and `flutter test` is where behaviour is
// provable.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (body: string, state: string) => `
system Shop {
  subdomain Sales { context Orders {
    aggregate Product { name: string  price: money }
    repository Products for Product { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    api Shop: ShopApi
    page List { route: "/products"  ${state}  body: ${body} }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

const TABLE = `QueryView { of: Shop.Product.all,
  loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" },
  data: rows => Table(
    Column("Name", p => p.name, sortable: true),
    rows: rows, sortKey: sortKey, sortDir: sortDir, page: pageNum, pageSize: 3,
    testid: "product-table") }`;
const STATE = `state { sortKey: string = ""  sortDir: string = "asc"  pageNum: int = 1 }`;

// The i18n-OFF fixture: a `Column` HEADER is a user-visible slot (`columnHeader`,
// M-T1.11), so a literal one is authored prose and would turn i18n on by itself.
// A dynamic header has no source string, which is what makes this page genuinely
// string-less — the state the two byte-identity cases below are about.
const OFF_TABLE = `QueryView { of: Shop.Product.all,
  data: rows => Table(
    Column(colHeader, p => p.name, sortable: true, field: "name"),
    rows: rows, sortKey: sortKey, sortDir: sortDir, page: pageNum, pageSize: 3,
    testid: "product-table") }`;
const OFF_STATE = `state { sortKey: string = ""  sortDir: string = "asc"  pageNum: int = 1  colHeader: string = "Name" }`;

const page = async (body = TABLE, state = STATE): Promise<string> =>
  (await generateSystemFiles(SYS(body, state))).get("app/lib/pages/list_page.dart")!;

describe("flutter Table controls — server-driven (M-T1.1)", () => {
  it("renders a tappable sort header that toggles direction on the active column", async () => {
    const dart = await page();
    // Re-tapping the ACTIVE column flips direction; a new one resets to asc.
    expect(dart).toContain("if (state.sortKey == 'name')");
    expect(dart).toContain("notifier.setSortDir(state.sortDir == 'asc' ? 'desc' : 'asc')");
    expect(dart).toContain("notifier.setSortKey('name'); notifier.setSortDir('asc')");
    // The header is a WIDGET, so the pack must not stringify it.
    expect(dart).toContain("DataColumn(label: InkWell(");
    expect(dart).not.toContain("DataColumn(label: Text('InkWell");
  });

  it("renders a pager whose ends disable", async () => {
    const dart = await page();
    expect(dart).toContain(
      "state.pageNum <= 1 ? null : () => notifier.setPageNum(state.pageNum - 1)",
    );
    // This fixture's page carries three authored literals (the QueryView's
    // loading / error / empty text), so the ui is i18n-enabled and the pager's
    // chrome BINDS (M-T1.11).  `const` goes with it: Dart rejects `const` over a
    // `t()` call, so constness has to follow the label.
    expect(dart).toContain("child: Text(t('chrome.next', 'Next'))");
    expect(dart).toContain("Text(t('chrome.pageOf', 'Page {page} of {pages}', <String, Object>{");
  });

  it("…and keeps `const Text` + the raw counter when the ui has nothing to translate", async () => {
    // The byte-identical half, on the target where it costs something real: drop
    // the three authored literals and the whole page is string-less, so no
    // runtime ships and the pager renders exactly what it did pre-i18n —
    // `const` included, which is the bit a naive "always bind" would silently
    // lose.
    const dart = await page(OFF_TABLE, OFF_STATE);
    expect(dart).toContain("child: const Text('Prev')");
    expect(dart).toContain("child: const Text('Next')");
    expect(dart).toContain("Text('Page ${state.pageNum} of ");
    expect(dart).not.toContain("chrome.");
    expect(dart).not.toContain("i18n.dart");
  });

  it("the sortable header's accessible NAME translates — and keeps its own with i18n off", async () => {
    // Flutter is the only target whose sortable header carries an explicit
    // name: a Dart widget has no implicit accessible name, so it wraps the
    // header in `Semantics(label: …)` where the JSX targets and Feliz render a
    // real `<button>` whose CONTENT names it.  That made it the last emitter-
    // built string on this target that no locale could reach.
    //
    // The hole is the header TEXT and it is STATIC — known at emit time — so it
    // rides in as a Dart string literal, unlike the grid's, which is read off
    // the TanStack column at runtime.
    const on = await page();
    expect(on).toContain(
      "label: t('chrome.sortBy', 'Sort by {column}', <String, Object>{'column': 'Name'})",
    );
    expect(on).not.toContain("label: 'Sort by Name'");

    // With nothing to translate the target keeps its own sentence — the
    // `undefined`-means-keep-yours contract, byte-identical by construction.
    const off = await page(OFF_TABLE, OFF_STATE);
    // The caption itself is dynamic here (that is what keeps the page
    // string-less), so the sentence names the emitter's fallback — what this
    // pins is that the target keeps ITS OWN sentence rather than binding.
    expect(off).toMatch(/label: 'Sort by [^']+'/);
    expect(off).not.toContain("chrome.sortBy");
  });

  it("emits Dart for the client page window — never JavaScript", async () => {
    const dart = await page();
    // The shared default is literal JS (`.slice`, `Math.max`, `Math.ceil`).
    // Emitting it into a `.dart` file does not compile.
    expect(dart).not.toContain("Math.max");
    expect(dart).not.toContain("Math.ceil");
    expect(dart).not.toContain(".slice(");
    expect(dart).toContain(".skip((state.pageNum - 1) * 3).take(3).toList()");
  });

  it("sorts by a typed switch, not a runtime row index", async () => {
    // Dart has no `row[key]`, so the comparator switches on the key with one
    // arm per sortable column — this is why `SortedRowsSpec` carries `columns`.
    const dart = await page();
    expect(dart).toContain("switch (state.sortKey)");
    expect(dart).toContain("'name' => (a.name as Comparable).compareTo(b.name as Comparable)");
    expect(dart).toContain("state.sortDir == 'desc' ? -c : c");
  });

  it("wraps the table and pager in one Column — Dart has no fragment", async () => {
    const dart = await page();
    // Adjacent widgets with no separator are a PARSE error, not a layout quirk.
    expect(dart).toContain(
      "Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[",
    );
  });

  it("binds the notifier for a body that only writes state through controls", async () => {
    // The controls are neither an action nor a bound input, so the two sets the
    // page shell used to consult were both empty and `notifier` went unbound.
    const dart = await page();
    expect(dart).toMatch(/final notifier = ref\.read\(\w+Provider\.notifier\);/);
  });

  it("leaves a control-free Table byte-identical (no pager, no sort wiring)", async () => {
    const dart = await page(
      `QueryView { of: Shop.Product.all, loading: Text { "…" }, error: Text { "e" },
        empty: Text { "none" },
        data: rows => Table(Column("Name", p => p.name), rows: rows, testid: "t") }`,
      "",
    );
    expect(dart).not.toContain("InkWell(onTap:");
    expect(dart).not.toContain("Text('Prev')");
    expect(dart).not.toContain("notifier.");
  });
});
