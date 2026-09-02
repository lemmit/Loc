// Flutter `store Cart { state {…} action … }` — the Stage 5 store seams.
//
// Flutter was the last frontend with NEITHER `renderStoreFieldRead` nor
// `renderStoreActionCall`, and walker-core throws on a missing seam — so a model
// that validated clean (`web/src/examples/store-showcase.ddd` retargeted at
// `platform: flutter`) failed codegen with a raw `Error("store: flutter not yet
// implemented")`.  A store is structurally a page's `state {}` + `action`s, so
// it projects onto the same Riverpod triad `riverpod-emit.ts` already builds.

import { describe, expect, it } from "vitest";
import { generateSystemFiles, generateSystemFilesUnchecked } from "../../_helpers/index.js";

const SYS = (extra = "") => `
system Shop {
  subdomain Sales { context Orders {
    aggregate Order { customerId: string }
    repository Orders for Order { } } }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui App {
    api Shop: ShopApi
    store Cart {
      state { lines: string[]  count: int = 0 }
      action add(sku: string) { lines += sku  count += 1 }
      action clear() { lines := [ ]  count := 0 }
    }
    ${extra}
    page CartPage {
      route: "/cart"
      state { confirming: bool = false }
      action discard() { Cart.clear() }
      body: Stack {
        Heading { "Cart", level: 1 },
        For { each: Cart.lines, line => Card { line } },
        Button { "Discard", onClick: discard }
      }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: ShopApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { Shop: api } port: 3006 }
}`;

const gen = (extra = "") => generateSystemFiles(SYS(extra));

/** For the ONE leg whose subject is a lifetime the flutter target refuses:
 *  `loom.store-lifetime-target-unsupported` firing is the premise, since the
 *  test asserts the emitter says so out loud instead of downgrading silently. */
const genUnchecked = (extra: string, why: string) => generateSystemFilesUnchecked(SYS(extra), why);

describe("flutter stores (Stage 5)", () => {
  it("no longer throws on a store-bearing ui", async () => {
    await expect(gen()).resolves.toBeInstanceOf(Map);
  });

  it("emits one Riverpod triad per store into lib/stores.dart", async () => {
    const dart = (await gen()).get("app/lib/stores.dart")!;
    expect(dart).toContain("class CartState {");
    expect(dart).toContain("final List<String> lines;");
    expect(dart).toContain("CartState copyWith({List<String>? lines, int? count})");
    expect(dart).toContain("class CartNotifier extends Notifier<CartState> {");
    expect(dart).toContain("return const CartState(lines: const [], count: 0);");
    expect(dart).toContain(
      "final cartProvider = NotifierProvider<CartNotifier, CartState>(CartNotifier.new);",
    );
  });

  it("lowers store-action bodies through the same statement projection page actions use", async () => {
    const dart = (await gen()).get("app/lib/stores.dart")!;
    expect(dart).toContain("void add(String sku) {");
    expect(dart).toContain("state = state.copyWith(lines: [...state.lines, sku]);");
    expect(dart).toContain("state = state.copyWith(count: state.count + 1);");
  });

  it("binds a field read as a granular watch and an action as a notifier tear-off", async () => {
    const dart = (await gen()).get("app/lib/pages/cart_page_page.dart")!;
    expect(dart).toContain("import '../stores.dart';");
    // The page reads `Cart.lines` in the body; the shell hoists the local the
    // body then references bare.
    expect(dart).toContain("final lines = ref.watch(cartProvider.select((s) => s.lines));");
    expect(dart).toContain("...lines.map((line) =>");
    // …and a store call from a page ACTION lands in the page's Notifier method,
    // which reaches the store through its own `ref` (never through an unbound
    // local — a Notifier has no shell to hoist one).
    expect(dart).toContain("void discard() {");
    expect(dart).toContain("ref.read(cartProvider.notifier).clear();");
    expect(dart).not.toContain("TODO(flutter full-parity): 'store-action'");
  });

  it("makes a store-only page a ConsumerWidget", async () => {
    // `ref` is what a store read needs; a StatelessWidget has none.
    const dart = (await gen()).get("app/lib/pages/cart_page_page.dart")!;
    expect(dart).toContain("class CartPagePage extends ConsumerWidget {");
    expect(dart).toContain("Widget build(BuildContext context, WidgetRef ref) {");
  });

  it("does not emit a duplicate setter when an action already owns the name", async () => {
    // `action setTerm(q)` beside `state { term }` — the generated `setTerm`
    // cell setter would be a SECOND `void setTerm(...)` in one Dart class,
    // which does not compile.  The hand-written action wins.
    const dart = (
      await gen(`store Filters {
      state { term: string = ""  pageNo: int = 0 }
      action setTerm(q: string) { term := q }
    }`)
    ).get("app/lib/stores.dart")!;
    expect(dart.match(/void setTerm\(/g)).toHaveLength(1);
    expect(dart).toContain("void setTerm(String q) {");
    // The uncontested cell keeps its generated setter.
    expect(dart).toContain("void setPageNo(int v) {");
  });

  // The lifetime ladder used to be a `// TODO(flutter full-parity)` comment over
  // an in-memory store; it now really persists (`store-persist.ts`), and its own
  // contract lives in `store-persist.test.ts`.  This case only pins that the
  // TRIAD is unchanged by it — the same `<Store>State` / `<Store>Notifier` /
  // `<store>Provider` a `memory` store gets.
  it("keeps the plain Riverpod triad under a non-memory lifetime", async () => {
    const dart = (
      await genUnchecked(
        `store Draft persist: local {
      state { note: string = "" }
      action write(t: string) { note := t }
    }`,
        "`persist: local` on flutter IS the subject — loom.store-lifetime-target-unsupported " +
          "is the gate that keeps the degradation honest, and this pins the emitter half of it",
      )
    ).get("app/lib/stores.dart")!;
    expect(dart).not.toContain("TODO(flutter full-parity)");
    expect(dart).toContain("class DraftNotifier extends Notifier<DraftState> {");
    expect(dart).toContain("void write(String t) {");
    expect(dart).toContain(
      "final draftProvider = NotifierProvider<DraftNotifier, DraftState>(DraftNotifier.new);",
    );
  });

  it("emits no stores file for a ui that declares none", async () => {
    const files = await generateSystemFiles(`
system Plain {
  subdomain S { context C { aggregate A { n: string } repository As for A { } } }
  api PlainApi from S
  ui App { api P: PlainApi  page Home { route: "/"  body: Stack { Heading { "hi", level: 1 } } } }
  storage loomDb { type: postgres }
  resource cState { for: C, kind: state, use: loomDb }
  deployable api { platform: node contexts: [C] dataSources: [cState] serves: PlainApi port: 3000 }
  deployable app { platform: flutter targets: api ui: App { P: api } port: 3006 }
}`);
    expect(files.has("app/lib/stores.dart")).toBe(false);
  });

  it("drops a store-reading COMPONENT rather than emitting an unbound name", async () => {
    // A component is a Stateless/StatefulWidget — no `WidgetRef`, so no store
    // access.  It falls out of the emittable set and its call site renders the
    // shared diagnostic comment; the alternative is Dart that cannot compile.
    const files = await generateSystemFiles(
      SYS()
        .replace(
          "page CartPage {",
          `component CartSummary() { body: Stack { Heading { Cart.count, level: 3 } } }
    page CartPage {`,
        )
        .replace('Heading { "Cart", level: 1 },', 'Heading { "Cart", level: 1 }, CartSummary(),'),
    );
    const page = files.get("app/lib/pages/cart_page_page.dart")!;
    expect(page).toContain("unknown layout component: CartSummary");
    expect(files.has("app/lib/components.dart")).toBe(false);
  });
});
