// M-T1.3 Phase 1 — an Angular page READS a query-time projection.
//
// Fourth leg after React (#2324), Vue (#2366) and Svelte (#2369).  Before a
// frontend ports, `PROJECTION_READ_FRAMEWORKS` gates it honestly, because a
// page reading a projection there emits an unresolved receiver
// (`undefined.<Projection>`) — a runtime TypeError AND a build break.
//
// Angular is the first FORK of the client emitter.  #2366's rule is reuse the
// shared `_frontend/projections-module.ts` while the divergence is leaf-shaped,
// fork when it is structural; Svelte reused it for three leaf options, and
// Angular cannot, because the emitted unit stops being "a zod schema plus a
// query hook" — it is a TS interface, an @Injectable service method, and an
// `injectQuery` factory that resolves its dependency through `inject()`.  The
// assertions below pin each of those four divergences, so the fork stays a
// REVIEWED decision rather than drift.
//
// What is NOT forked, and is asserted here too: the readability predicate.
// `readableProjections` still comes from the shared module, so all four
// frontends agree on WHICH projections are readable even where they disagree
// on how to emit the client.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** The same system as the React/Vue/Svelte suites, on `platform: angular`. */
const SRC = `
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
      criterion Confirmed of Order as o = o.status == OrderStatus.Confirmed
      projection SalesTotals {
        orders: int
        revenue: money
        from Order as o
        where Confirmed
        select orders = count, revenue = sum(o.total)
      }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        QueryView {
          of: Sales.SalesTotals,
          empty: Text { "No data" },
          data: t => Group {
            Stat { "Orders", t.orders },
            Stat { "Revenue", Money { t.revenue } }
          }
        }
      }
    }
  }

  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: angular targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The angular deployable's files, path-prefixed off the system tree. */
async function files(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

const dashPage = async (src = SRC) =>
  (await files(src)).get("src/app/pages/dash.component.ts") ??
  (() => {
    throw new Error("no dash component emitted");
  })();

describe("angular projection client — the forked emitter", () => {
  it("emits `src/api/projections.ts`", async () => {
    expect((await files()).has("src/api/projections.ts")).toBe(true);
  });

  it("emits a TS interface, NOT a zod schema", async () => {
    // Divergence 1.  Angular types the read through `HttpClient`'s generic, so
    // there is no `z.object({…})` and no `.parse(r)` runtime boundary to emit.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export interface SalesTotalsRow {");
    expect(m).toContain("  orders: number;");
    expect(m).not.toContain("z.object");
    expect(m).not.toContain(".parse(");
    expect(m).not.toContain('from "zod"');
  });

  it("maps wire `money` to string — no decimal.js, no moneySchema", async () => {
    // Divergence 4, and the reason the Angular `formatMoney` gap #2366 flagged
    // is UNREACHABLE on this path: Angular never produces a `Decimal` here, so
    // the pack formatter's `number | string` signature already accepts it.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("  revenue: string;");
    expect(m).not.toContain("moneySchema");
  });

  it("reads through an @Injectable service wrapping HttpClient", async () => {
    // Divergence 2 — a free `api.get(...)` has no counterpart here.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain(`@Injectable({ providedIn: "root" })`);
    expect(m).toContain("export class ProjectionsService {");
    expect(m).toContain("  private readonly http = inject(HttpClient);");
    expect(m).toContain(
      "    return this.http.get<SalesTotalsRow>(`${API_BASE_URL}/projections/sales_totals`);",
    );
  });

  it("exposes the read as an injectQuery factory resolving its own dependency", async () => {
    // Divergence 3.  A singleton read takes no id and no query params — the
    // projection IS the row — so the service method and the factory are nullary.
    const m = (await files()).get("src/api/projections.ts")!;
    expect(m).toContain("export function useSalesTotals() {");
    expect(m).toContain("  const service = inject(ProjectionsService);");
    expect(m).toContain("  return injectQuery(() => ({");
    expect(m).toContain('    queryKey: ["projections", "sales_totals"] as const,');
    expect(m).toContain("    queryFn: () => firstValueFrom(service.salesTotals()),");
  });

  it("is NOT emitted for a projection-free app", async () => {
    // The module is emitted on demand, so a projection-free app is unchanged.
    const plain = `system S {
  subdomain Sales { context Orders {
    aggregate Order { code: string  derived display: string = code }
    repository Orders for Order {}
  } }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Dash { route: "/dash"  title: "D"  body: Stack { Text { "hi" } } }
  }
  deployable api { platform: node contexts: [Orders] dataSources: [ordersState] serves: SalesApi port: 8080 }
  deployable web { platform: angular targets: api ui: WebApp { Sales: api } port: 3000 }
}`;
    expect((await files(plain)).has("src/api/projections.ts")).toBe(false);
  });

  it("agrees with the SHARED readability predicate", async () => {
    // The fork is of the EMITTER, not of the rule about what is emittable — a
    // keyed (non-singleton) projection is unreadable on every frontend, so
    // Angular must not emit a client for one either.
    const keyed = SRC.replace(
      "projection SalesTotals {\n        orders: int",
      "projection SalesTotals {\n        key code: string\n        orders: int",
    );
    const all = await files(keyed).catch(() => new Map<string, string>());
    const m = all.get("src/api/projections.ts");
    if (m) expect(m).not.toContain("useSalesTotals");
  });
});

describe("angular projection read in a page", () => {
  it("hoists the read as a class field — no unresolved receiver", async () => {
    // The field initializer is the injection context `inject()` needs; Angular
    // components have no function body to hoist a `const` into.
    const page = await dashPage();
    expect(page).toContain(`import { useSalesTotals } from "../../api/projections";`);
    expect(page).toContain("readonly salesTotals = useSalesTotals();");
    // The defect this closes.
    expect(page).not.toContain("unresolved");
    expect(page).not.toContain("undefined.SalesTotals");
  });

  it("binds SINGLE-record, since a singleton returns one object", async () => {
    // The collection semantics (`.length === 0` / `> 0`) would read `.length`
    // on an object — always undefined, so the body would never render.  Derived
    // from the query, not from an author-written `single:`; the detection lives
    // in `_walker/primitives/controls.ts` and must precede `autoPaged`, which
    // would otherwise unwrap an `.items` the object has not.
    const page = await dashPage();
    expect(page).toContain("@if (salesTotals.data()) {");
    expect(page).not.toContain("salesTotals.data()?.items");
    expect(page).not.toContain("salesTotals.data().length");
  });

  it("reads row fields off the signal call", async () => {
    expect(await dashPage()).toContain("salesTotals.data()!.orders");
  });

  it("renders a money value through the pack's formatter", async () => {
    expect(await dashPage()).toContain("formatMoney(salesTotals.data()!.revenue)");
  });
});
