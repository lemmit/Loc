// M-T1.3 Phase 1 — a Feliz (F#/Elmish) page READS a query-time projection.
//
// Fifth leg after React (#2324), Vue (#2366), Svelte (#2369) and Angular
// (#2376).  Those four each emit ONE artefact — a client module whose
// `use<Proj>()` the page calls.  Elmish has no hook to emit, so a projection
// read here is FOUR coordinated emissions, and the value of this suite is that
// it pins all four *and* their agreement with each other:
//
//   1. a `<Proj>Row` record + Thoth decoder (the wire layer)
//   2. a paramless `Api.<proj>` fetch returning `Result<Row option, string>`
//   3. a `Remote<Row option>` Model field, `Msg` case and init `Cmd`
//   4. an update arm storing `Loaded data`, rendered via `View.remoteOne`
//
// Three of those (Msg case, init Cmd, update arm) are DERIVED from the read
// descriptor rather than written by the projection code — that is the whole
// point of joining the existing pipeline instead of forking a parallel one, and
// the assertions below are what would catch the pipeline drifting away from it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

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
  deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3000 }
}
`;

/** The emitted `App.fs` — Feliz puts the whole MVU app in one file. */
async function appFs(src = SRC): Promise<string> {
  const files = await generateSystemFiles(src);
  const hit = [...files].find(([p]) => p.endsWith("App.fs"));
  if (!hit) throw new Error(`no App.fs emitted; got ${[...files.keys()].join(", ")}`);
  return hit[1];
}

describe("feliz projection read — the wire layer", () => {
  it("emits a row record off the SAME wireShape the other frontends use", async () => {
    // `<Proj>Row` here, `<Proj>Row` on the backend, `<Proj>Response` on the JS
    // frontends — all three built from `wireShape`, so they cannot drift.
    const fs = await appFs();
    expect(fs).toContain("type SalesTotalsRow =");
    expect(fs).toContain("    orders: int");
    // `money` is F# `decimal` — no decimal.js analogue, and no `option` wrapper
    // (the aggregate columns are non-null; SQL aggregates always yield a row).
    expect(fs).toContain("    revenue: decimal");
  });

  it("emits a Thoth decoder for the row", async () => {
    const fs = await appFs();
    expect(fs).toContain("let salesTotalsRow : Decoder<SalesTotalsRow> =");
    expect(fs).toContain('orders = get.Required.Field "orders" Decode.int');
    expect(fs).toContain('revenue = get.Required.Field "revenue" Decode.decimal');
  });

  it("fetches the projection's own route with NO arguments", async () => {
    // A singleton read takes no id and no query — the projection IS the row —
    // so the api fn is nullary, unlike `orderById`.
    const fs = await appFs();
    expect(fs).toContain("let salesTotals () : Async<Result<SalesTotalsRow option, string>> =");
    expect(fs).toContain('Http.get "/api/projections/sales_totals"');
    // `Decode.map Some` lifts the one decoded object into the `option` that
    // `View.remoteOne` consumes — which is what lets the byId rendering path be
    // reused wholesale instead of growing a third matcher.
    expect(fs).toContain("Decode.map Some Decoders.salesTotalsRow");
  });
});

describe("feliz projection read — the MVU wiring (derived, not hand-written)", () => {
  it("puts the read in the Model as a Remote option", async () => {
    expect(await appFs()).toContain("SalesTotals: Remote<SalesTotalsRow option>");
  });

  it("carries the decoded Result on a Msg case", async () => {
    expect(await appFs()).toContain("| SalesTotalsLoaded of Result<SalesTotalsRow option, string>");
  });

  it("fires at INIT, paramless — not on page entry keyed by a route id", async () => {
    // The distinction `FelizRead.projection` exists to express: single-record
    // SHAPE, but list-style firing.  A byId read would appear in `pageCmd`
    // instead, keyed off the route id a projection does not have.
    const fs = await appFs();
    expect(fs).toContain("Cmd.OfAsync.perform Api.salesTotals () SalesTotalsLoaded");
    expect(fs).toContain("SalesTotals = Loading");
  });

  it("stores the loaded value and the error in the update function", async () => {
    const fs = await appFs();
    expect(fs).toContain(
      "| SalesTotalsLoaded (Ok data) -> { model with SalesTotals = Loaded data }",
    );
    expect(fs).toContain(
      "| SalesTotalsLoaded (Error e) -> { model with SalesTotals = LoadError e }",
    );
  });
});

describe("feliz projection read — the view", () => {
  it("renders through remoteOne, the SINGLE-record matcher", async () => {
    // A singleton returns ONE object; `remoteList` would be the wrong matcher
    // and would not typecheck against `Remote<'T option>`.
    const fs = await appFs();
    expect(fs).toContain("View.remoteOne model.SalesTotals");
    expect(fs).toContain("(fun salesTotals ->");
  });

  it("reads row fields straight off the match binding", async () => {
    // The `Loaded` arm already unwrapped the Remote, so there is no `.data`
    // dereference the JS frontends need.
    const fs = await appFs();
    expect(fs).toContain("salesTotals.orders");
    expect(fs).toContain("salesTotals.revenue");
  });

  it("emits remoteOne even though no byId read exists on the page", async () => {
    // The regression this guards: `remoteOne` used to be emitted only when some
    // read had `single: true`, which a projection deliberately does not set —
    // so a projection-only page compiled without the matcher it calls.
    const fs = await appFs();
    expect(fs).toContain("let remoteOne");
    expect(fs).not.toContain("OrderById");
  });
});
