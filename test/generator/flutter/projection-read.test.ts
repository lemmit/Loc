// M-T1.3 Phase 1 — a Flutter (Dart/Riverpod) page READS a query-time
// projection.  Sixth and LAST leg, after React (#2324), Vue (#2366), Svelte
// (#2369), Angular (#2376) and Feliz (#2467).
//
// Flutter forks the client-module emitter (no zod, no TanStack Query, and the
// unit a page consumes is a `FutureProvider` it `ref.watch`es rather than a
// hook), but it does NOT fork the readability predicate — the last describe
// below is what holds that line.
//
// The emission is two halves that have to agree: a `<Proj>Row` class in
// `models.dart` and a provider in `reads.dart` that decodes into it.  Both are
// derived from one `FlutterRead` descriptor, and these assertions are what
// would catch them drifting apart — or, more likely, the page hoisting a
// `ref.watch(<var>Provider)` for a provider the collector never emitted (the
// exact failure `collectFlutterReads` used to have, since it skipped
// projection reads while the walker resolved them).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** `select orders = count, revenue = sum(o.total)` — no `group by`, so ONE row. */
const SINGLETON = `
system Shop {
  subdomain Sales {
    context Orders {
      enum OrderStatus { Draft Confirmed }
      aggregate Order {
        code: string
        total: money
        status: OrderStatus
        derived display: string = code
      }
      repository Orders for Order {}
      criterion ConfirmedOrders of Order as o = o.status == OrderStatus.Confirmed
      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where ConfirmedOrders
        select orders = count, revenue = sum(o.total)
      }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  resource ordersState { for: Orders, kind: state, use: pg }
  ui WebApp {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        QueryView {
          of: Sales.SalesTotals,
          loading: Text { "Loading" },
          error: Text { "Failed" },
          empty: Text { "No data" },
          data: t => Stack {
            Text { t.orders },
            Money { t.revenue }
          }
        }
      }
    }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable shopApp { platform: flutter targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The same projection with `group by` — one row PER GROUP, so the list shape. */
const GROUPED = SINGLETON.replace(
  `      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where ConfirmedOrders
        select orders = count, revenue = sum(o.total)
      }`,
  `      projection SalesTotals {
        status: OrderStatus
        orders: int
        from Order as o
        group by o.status
        select status = o.status, orders = count
      }`,
).replace(
  `          data: t => Stack {
            Text { t.orders },
            Money { t.revenue }
          }`,
  `          data: rows => Stack {
            For { each: rows, r => Text { r.orders } }
          }`,
);

async function emitted(src: string): Promise<Map<string, string>> {
  return generateSystemFiles(src);
}

function file(files: Map<string, string>, suffix: string): string {
  const hit = [...files].find(([p]) => p.endsWith(suffix));
  if (!hit) throw new Error(`no ${suffix} emitted; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("flutter projection read — the row model", () => {
  it("emits a `<Proj>Row` class off the SAME wireShape the other frontends use", async () => {
    // `<Proj>Row` here, `<Proj>Row` on the backend, `<Proj>Response` on the JS
    // frontends — all built from `wireShape`, so they cannot drift.
    const models = file(await emitted(SINGLETON), "lib/models.dart");
    expect(models).toContain("class SalesTotalsRow {");
    expect(models).toContain("  final int orders;");
    // `money` lowers to Dart `double`, the same as an aggregate's money column
    // — a projection row is not a special wire dialect.
    expect(models).toContain("  final double revenue;");
  });

  it("gives the row a fromJson the provider decodes through", async () => {
    const models = file(await emitted(SINGLETON), "lib/models.dart");
    expect(models).toContain("factory SalesTotalsRow.fromJson(Map<String, dynamic> json)");
    expect(models).toContain("orders: json['orders'] as int,");
  });

  it("names it `…Row`, so it cannot collide with an aggregate of the same name", async () => {
    // The projection is `SalesTotals`; a `class SalesTotals` would be the
    // collision an author hits the moment they name an aggregate after a
    // projection (or vice versa) — cheap to avoid, expensive to discover.
    const models = file(await emitted(SINGLETON), "lib/models.dart");
    expect(models).not.toMatch(/^class SalesTotals \{$/m);
  });
});

describe("flutter projection read — the provider", () => {
  it("is a PARAMLESS FutureProvider, not a .family", async () => {
    // A singleton takes no id and no query key — the projection IS the row.
    // `.family` is for byId (keyed by a route id) and for paged lists (keyed by
    // the query record); a projection has neither.
    const reads = file(await emitted(SINGLETON), "lib/reads.dart");
    expect(reads).toContain("final salesTotalsReadProvider = FutureProvider<SalesTotalsRow?>(");
    expect(reads).not.toContain("salesTotalsReadProvider = FutureProvider.family");
  });

  it("fetches the projection's own route", async () => {
    const reads = file(await emitted(SINGLETON), "lib/reads.dart");
    expect(reads).toContain("await http.get(apiUri('/projections/sales_totals'))");
    expect(reads).toContain(
      "return SalesTotalsRow.fromJson(jsonDecode(res.body) as Map<String, dynamic>);",
    );
  });

  it("does NOT unwrap a paged `items` envelope", async () => {
    // `.all` is paged-by-default (M-T2.6) and unwraps `body['items']`; a
    // projection route returns the bare object.  Decoding one as the other
    // throws at RUNTIME, and `flutter analyze` cannot see a wrong JSON shape —
    // so this is asserted here or nowhere.
    const reads = file(await emitted(SINGLETON), "lib/reads.dart");
    const block = reads.slice(reads.indexOf("salesTotalsReadProvider"));
    expect(block).not.toContain("body['items']");
  });

  it("yields a NULLABLE row so the authored `empty:` branch stays legal Dart", async () => {
    // The walker renders `empty:` as a `== null` guard on the bound value.
    // Against a non-nullable Dart type that comparison is a dead-code warning
    // `flutter analyze` fails on — and dropping the guard instead would
    // silently discard markup the author wrote.  Feliz lifts the same read
    // into `Row option` for the same reason.
    const reads = file(await emitted(SINGLETON), "lib/reads.dart");
    expect(reads).toContain("FutureProvider<SalesTotalsRow?>");
    expect(reads).toContain("if (res.statusCode == 404) return null;");
  });

  it("yields a LIST for a grouped projection — one row per group", async () => {
    const reads = file(await emitted(GROUPED), "lib/reads.dart");
    expect(reads).toContain("FutureProvider<List<SalesTotalsRow>>");
    expect(reads).toContain("await http.get(apiUri('/projections/sales_totals'))");
    // A bare array, not the `{items: […]}` envelope — same wire the JS clients
    // parse with `z.array(<Proj>Row)`.
    expect(reads).toContain("final rows = jsonDecode(res.body) as List<dynamic>;");
  });
});

describe("flutter projection read — the page", () => {
  it("hoists a ref.watch for the provider that is actually emitted", async () => {
    // The regression this guards is the concrete one that existed before this
    // port: the walker resolved `Sales.SalesTotals` and hoisted
    // `ref.watch(salesTotalsReadProvider)`, while `collectFlutterReads` skipped
    // projection reads — so the page imported `reads.dart` for a provider that
    // was never written, and the project did not analyze.
    const files = await emitted(SINGLETON);
    const page = file(files, "lib/pages/dash_page.dart");
    const reads = file(files, "lib/reads.dart");
    expect(page).toContain("final salesTotalsRead = ref.watch(salesTotalsReadProvider);");
    expect(page).toContain("import '../reads.dart';");
    expect(reads).toContain("salesTotalsReadProvider");
  });

  it("dispatches through `.when` and reads fields off the loaded binding", async () => {
    const page = file(await emitted(SINGLETON), "lib/pages/dash_page.dart");
    expect(page).toContain("salesTotalsRead.when(");
    expect(page).toContain("salesTotalsRead.orders");
  });

  it("treats the singleton as ONE object — no collection semantics", async () => {
    // A singleton returns one object, so the walker must not reach the
    // auto-paged branch that appends `.items` to the binding.  That detection
    // has to precede `autoPaged`, and `.items` on a `<Proj>Row` is a Dart
    // compile error rather than a silent nothing.
    const page = file(await emitted(SINGLETON), "lib/pages/dash_page.dart");
    expect(page).not.toContain("salesTotalsRead.items");
  });
});

describe("flutter forks the emitter, NOT the readability rule", () => {
  it("agrees with the shared predicate about what is readable", async () => {
    // Every port so far has held this line: the framework decides how to emit
    // a projection read, never WHETHER a given projection is readable.  A
    // keyed projection is unreadable on every frontend, so Flutter must emit
    // no row and no provider for it — not "a Flutter-shaped opinion about it".
    const keyed = SINGLETON.replace(
      "      projection SalesTotals {",
      `      projection ByCode keyed by code {
        code: string
        n: int
        from Order as o
        group by o.code
        select code = o.code, n = count
      }
      projection SalesTotals {`,
    );
    const files = await emitted(keyed);
    expect(file(files, "lib/models.dart")).not.toContain("class ByCodeRow");
    expect(file(files, "lib/reads.dart")).not.toContain("byCodeReadProvider");
    // …and the readable sibling in the same context is unaffected.
    expect(file(files, "lib/models.dart")).toContain("class SalesTotalsRow");
  });
});
