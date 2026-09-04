// Flutter `store … persist: local|session|url` — the lifetime ladder
// (frontend-state-management.md §3.1).
//
// Before this, `flutter/store-builder.ts` wrote a `// TODO(flutter full-parity)`
// comment and built the store IN-MEMORY regardless: the cart did not survive a
// restart, the filter was not shareable by URL, and nothing in the build output
// said so.  The ladder now rides the Riverpod triad — `build()` seeds each cell
// from its backing store, a `ref.listenSelf` mirror writes the whole state back,
// and the `url` tier re-reads the query string on browser back/forward.
//
// The assertions below are the CONTRACT, not the prose: the shared_preferences
// key is the same `loom.store.<Name>` the four JS builders write, the blob is a
// JSON object keyed by the BARE field name (money a string, decimal a number),
// and the query-param encoding matches `encodeFieldToParam` in
// `react/store-builder.ts` (a string dropped when empty, a bool set only when
// true, a number always written).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (stores: string) => `
system Shop {
  subdomain Sales { context Orders {
    aggregate Order { customerId: string }
    repository Orders for Order { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    api Shop: ShopApi
    ${stores}
    page CartPage {
      route: "/cart"
      body: Stack { Heading { "Cart", level: 1 } }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

const LOCAL = `store Cart persist: local {
      state { lines: string[]  count: int = 0  total: money }
      action add(sku: string) { lines += sku  count += 1 }
    }`;

const SESSION = `store Recent persist: session {
      state { term: string = "" }
      action setTerm(q: string) { term := q }
    }`;

const URL_STORE = `store Filters persist: url {
      state { q: string = ""  page: int = 1  onlyOpen: bool = false }
      action setQ(v: string) { q := v }
    }`;

const MEMORY = `store Draft {
      state { note: string = "" }
      action setNote(v: string) { note := v }
    }`;

const gen = (stores: string) => generateSystemFiles(SYS(stores));

describe("flutter `persist: local` — shared_preferences, JS-compatible key + blob", () => {
  it("seeds every cell from the stored blob and mirrors the state back", async () => {
    const out = await gen(LOCAL);
    const dart = out.get("app/lib/stores.dart")!;
    // The TODO the emitter used to write in place of the feature is gone.
    expect(dart).not.toContain("TODO(flutter full-parity)");
    expect(dart).toContain("import 'store_persist.dart';");
    // Same key the React / Vue / Svelte / Angular builders write.
    expect(dart).toContain("static const String _persistKey = 'loom.store.Cart';");
    expect(dart).toContain("ref.listenSelf((_, next) => _persist(next));");
    expect(dart).toContain("final blob = LoomStorePersist.read(_persistKey);");
    expect(dart).toContain(
      "return CartState(lines: _loadLines(blob), count: _loadCount(blob), total: _loadTotal(blob));",
    );
  });

  it("each loader is TOTAL — junk in the blob falls back to the declared default", async () => {
    const dart = (await gen(LOCAL)).get("app/lib/stores.dart")!;
    expect(dart).toContain("if (raw == null) return 0;");
    expect(dart).toContain("return raw is int ? raw : int.tryParse(raw.toString()) ?? 0;");
    expect(dart).toContain("if (raw is! List) return const [];");
  });

  it("writes the JS blob shape: bare field keys, money as a STRING, int as a number", async () => {
    const dart = (await gen(LOCAL)).get("app/lib/stores.dart")!;
    expect(dart).toContain("LoomStorePersist.write(_persistKey, <String, dynamic>{");
    expect(dart).toContain("'lines': s.lines,");
    expect(dart).toContain("'count': s.count,");
    // `money` rides the wire as a JSON string — the JS side holds a `Decimal`,
    // whose `toJSON` is one.
    expect(dart).toContain("'total': s.total.toString(),");
  });

  it("pulls shared_preferences into the pubspec and awaits it before runApp", async () => {
    const out = await gen(LOCAL);
    expect(out.get("app/pubspec.yaml")!).toContain("shared_preferences: ^2.3.2");
    const main = out.get("app/lib/main.dart")!;
    // M-T1.8 (flutter arm): the persist-boot work runs inside the
    // `runZonedGuarded` async closure, so `main()` itself stays sync.
    expect(main).toContain("void main() {");
    expect(main).toContain("runZonedGuarded(() async {");
    expect(main).toContain("WidgetsFlutterBinding.ensureInitialized();");
    expect(main).toContain("await LoomStorePersist.init();");
    // The runtime sets the EMPTY prefix, so the web key is the bare
    // `loom.store.<Name>` and not the plugin's `flutter.`-prefixed default.
    expect(out.get("app/lib/store_persist.dart")!).toContain("SharedPreferences.setPrefix('');");
  });
});

describe("flutter `persist: session` — the same backing, wiped at boot", () => {
  it("registers the store's key in the start-up clear list", async () => {
    const runtime = (await gen(SESSION)).get("app/lib/store_persist.dart")!;
    expect(runtime).toContain("static const List<String> _sessionKeys = <String>[");
    expect(runtime).toContain("'loom.store.Recent',");
    expect(runtime).toContain("await prefs.remove(key);");
  });
});

describe("flutter `persist: url` — the query string is the source of truth", () => {
  it("seeds each cell from a query param, defaulting on anything unparseable", async () => {
    const dart = (await gen(URL_STORE)).get("app/lib/stores.dart")!;
    expect(dart).toContain("final raw = LoomStorePersist.param('q');");
    expect(dart).toContain("return int.tryParse(raw) ?? 1;");
    expect(dart).toContain("return raw == 'true';");
  });

  it("mirrors back with the SAME encoding `encodeFieldToParam` uses", async () => {
    const dart = (await gen(URL_STORE)).get("app/lib/stores.dart")!;
    expect(dart).toContain("LoomStorePersist.writeParams(<String, String?>{");
    // A string is DROPPED when empty …
    expect(dart).toContain("'q': s.q.isEmpty ? null : s.q,");
    // … a number is ALWAYS written (`0` is a real value, not "empty") …
    expect(dart).toContain("'page': s.page.toString(),");
    // … and a bool is set only when true.
    expect(dart).toContain("'onlyOpen': s.onlyOpen ? 'true' : null,");
  });

  it("re-reads the query string on browser back/forward", async () => {
    const out = await gen(URL_STORE);
    const dart = out.get("app/lib/stores.dart")!;
    expect(dart).toContain("void hydrateFromUrl() {");
    expect(dart).toContain("class LoomUrlStoreSync extends ConsumerStatefulWidget {");
    expect(dart).toContain(
      "Future<bool> didPushRouteInformation(RouteInformation routeInformation) async {",
    );
    expect(dart).toContain("ref.read(filtersProvider.notifier).hydrateFromUrl();");
    // …and the observer actually wraps the app.
    expect(out.get("app/lib/main.dart")!).toContain(
      "return ProviderScope(child: LoomUrlStoreSync(child: MaterialApp(",
    );
  });

  it("needs no pub package — `Uri.base` + `SystemNavigator` are core", async () => {
    const out = await gen(URL_STORE);
    expect(out.get("app/pubspec.yaml")!).not.toContain("shared_preferences");
    const runtime = out.get("app/lib/store_persist.dart")!;
    expect(runtime).not.toContain("import 'package:shared_preferences/");
    expect(runtime).not.toContain("SharedPreferences");
    expect(runtime).toContain("SystemNavigator.routeInformationUpdated(");
    // A url-only app's `main()` stays synchronous — nothing to await.
    expect(out.get("app/lib/main.dart")!).toContain("void main() {");
  });
});

describe("flutter `persist: memory` — byte-identical to the pre-persistence output", () => {
  it("emits no runtime, no import, no pubspec dep and a const seed", async () => {
    const out = await gen(MEMORY);
    expect(out.has("app/lib/store_persist.dart")).toBe(false);
    const dart = out.get("app/lib/stores.dart")!;
    expect(dart).not.toContain("store_persist.dart");
    expect(dart).not.toContain("listenSelf");
    expect(dart).toContain("return const DraftState(note: '');");
    expect(out.get("app/pubspec.yaml")!).not.toContain("shared_preferences");
    expect(out.get("app/lib/main.dart")!).toContain("void main() {");
  });
});
