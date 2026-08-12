// M-T1.3 Phase 1 — a Phoenix/LiveView page READS a query-time projection.
//
// Fifth and last leg after react (#2324), vue (#2366), svelte (#2369) and
// angular (#2376).  Before this, `PROJECTION_READ_FRAMEWORKS` gated
// `phoenixLiveView` honestly: a page reading a projection there resolved to
// nothing, so the assign the `QueryView` cond reads was never populated.
//
// The Phoenix leg is the odd one, and cheaper than any SPA leg, because a
// LiveView deployable hosts its CONTEXTS IN THE SAME OTP APP as its ui.  What
// the four SPA frontends fetch over `GET /projections/<slug>` — an api module,
// a zod (or interface) row schema, a TanStack query hook — collapses here to a
// single in-process call to the projection's own `run/1`.  There is no
// projection CLIENT to emit at all.
//
// Two things that are NOT free, and are what this pins:
//
//   - THE REKEY.  `run/1` returns the WIRE row (camelCase atom keys — it is
//     JSON-encoded straight onto the HTTP response), while every other record a
//     HEEx body reads is an Ecto struct with snake_case fields, which is what
//     the walker emits for a member access.  Rekeying once in the loader keeps
//     the whole page body — nested `Table` column lambdas included — on one
//     naming convention.
//   - THE ASSIGN NAME.  It comes from the PROJECTION, not from the `data:`
//     lambda's parameter.  The scaffolded dashboard puts one KPI `QueryView`
//     per aggregate on `Home`, every one written by the same macro with the
//     same param `t`; named off the param they would all assign `:t` and the
//     last load would win.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** One singleton + one grouped + one shorthand projection, all read by a page
 *  hosted on the SAME elixir deployable that serves the context. */
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
      projection SalesByStatus {
        status: OrderStatus
        orderCount: int
        revenue: money
        from Order as o
        group by o.status
        select status = o.status, orderCount = count(), revenue = sum(o.total)
      }
      projection BigOrders { from Order as o where Confirmed }
    }
  }

  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primarySql }

  ui WebApp {
    api Sales: SalesApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        QueryView {
          of: Sales.SalesTotals,
          data: t => Group { Stat { "Orders", t.orders }, Stat { "Revenue", Money { t.revenue } } }
        },
        QueryView {
          of: Sales.SalesByStatus,
          empty: Text { "No rows" },
          data: rows => Table(
            Column("Status", r => r.status),
            Column("Orders", r => r.orderCount),
            rows: rows)
        },
        QueryView {
          of: Sales.BigOrders,
          empty: Text { "No big orders" },
          data: rows => Table(Column("Code", r => r.code), rows: rows)
        }
      }
    }
  }

  deployable web {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
    serves: SalesApi
    ui: WebApp { Sales: web }
    port: 4000
  }
}
`;

/** The elixir deployable's files, path-stripped off the system tree. */
async function files(src = SRC): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [path, content] of all) {
    if (path.startsWith("web/")) out.set(path.slice("web/".length), content);
  }
  return out;
}

const dash = async (src = SRC): Promise<string> => {
  const page = (await files(src)).get("lib/web_web/live/dash_live.ex");
  expect(page, "expected the Dash LiveView to be emitted").toBeDefined();
  return page!;
};

describe("HEEx projection read — the in-process loader", () => {
  it("emits no projection api client — the read is a function call", async () => {
    const f = await files();
    // The SPA frontends' whole `api/projections` module has no counterpart here.
    expect([...f.keys()].some((p) => p.includes("projections") && p.endsWith(".ts"))).toBe(false);
    expect(await dash()).toContain("Web.Orders.QueryProjections.SalesTotals.run(current_user)");
  });

  it("threads current_user exactly as the HTTP controller does", async () => {
    // Same value the `QueryProjectionsController` action passes, so the source
    // aggregate's capability filter (tenancy / soft delete) scopes the read
    // identically whether it is reached through the route or the LiveView.
    const page = await dash();
    expect(page).toContain("current_user = Map.get(socket.assigns, :current_user)");
    const controller = (await files()).get(
      "lib/web_web/controllers/query_projections_controller.ex",
    )!;
    expect(controller).toContain("current_user = Map.get(conn.assigns, :current_user)");
  });

  it("loads in handle_params, one assign per projection", async () => {
    const page = await dash();
    expect(page).toContain("socket = assign(socket, :sales_totals, load_sales_totals(socket))");
    expect(page).toContain(
      "socket = assign(socket, :sales_by_status, load_sales_by_status(socket))",
    );
  });
});

describe("HEEx projection read — the wire→snake rekey", () => {
  it("rekeys the singleton row and reads it snake_cased in the body", async () => {
    const page = await dash();
    expect(page).toContain("row = Web.Orders.QueryProjections.SalesTotals.run(current_user)");
    expect(page).toContain("%{orders: row.orders, revenue: row.revenue}");
    expect(page).toContain("@sales_totals.orders");
  });

  it("maps the grouped LIST and rekeys a camelCase column", async () => {
    const page = await dash();
    // `orderCount` on the wire; `:order_count` in the assign — and the Table's
    // own column lambda reads the snake key, which is the whole point of doing
    // this at the load site instead of teaching the walker a second convention.
    expect(page).toContain("|> Enum.map(fn row -> ");
    expect(page).toContain("order_count: row.orderCount");
    expect(page).toContain("r.order_count");
  });

  it("treats a SHORTHAND projection as the LIST shape, not one object", async () => {
    // `projection BigOrders { from Order as o where Confirmed }` returns the
    // filtered SOURCE ROWS — an array.  Answered through `projectionReadShape`,
    // which used to ask `isGroupedProjection` alone and called this one single.
    const page = await dash();
    expect(page).toContain("Web.Orders.QueryProjections.BigOrders.run(current_user)");
    expect(page).toContain("Enum.empty?(@big_orders)");
    expect(page).not.toContain("row = Web.Orders.QueryProjections.BigOrders.run");
  });
});

describe("HEEx projection read — the assign name", () => {
  it("names the assign after the projection, not the data lambda's param", async () => {
    // Both grouped views below bind `rows`; both singletons bind `t`.  Named off
    // the param they would collide on `:items` / `:t`.
    const page = await dash();
    expect(page).toContain("@sales_totals");
    expect(page).toContain("@sales_by_status");
    expect(page).toContain("@big_orders");
  });

  it("gives each default-id Table its own DOM id", async () => {
    // `<.table>`'s `id` must be unique for LiveView DOM patching.  One table per
    // page was the norm before projections were readable; a dashboard reading
    // several is not.
    const page = await dash();
    expect(page).toContain(`<.table id="data-table" `);
    expect(page).toContain(`<.table id="data-table-2" `);
  });
});

/** The same shape, one projection, with a read-side `requires` gate. */
const GATED = `
system Helpdesk {
  user { id: string role: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
    sessions: cookie
    claims: { role: "realm_access.roles" }
  }
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish { subject: string open: bool }
      repository Tickets for Ticket { }
      projection TicketTotals requires currentUser.role == "agent" {
        tickets: int
        from Ticket as t
        select tickets = count
      }
    }
  }
  api SupportApi from Support
  storage primary { type: postgres }
  resource ticketState { for: Tickets, kind: state, use: primary }
  ui WebApp {
    api Support: SupportApi
    page Dash {
      route: "/dash"
      title: "Dashboard"
      body: Stack {
        QueryView { of: Support.TicketTotals, data: t => Stat { "Tickets", t.tickets } }
      }
    }
  }
  deployable web {
    platform: elixir
    contexts: [Tickets]
    dataSources: [ticketState]
    serves: SupportApi
    ui: WebApp { Support: web }
    auth: required
    port: 4000
  }
}
`;

describe("HEEx projection read — the requires gate", () => {
  it("gates the LiveView read with the SAME predicate the route gates with", async () => {
    // A read authorized on one seam only is the failure this closes: the HTTP
    // route 403s while the LiveView, reading the same projection in-process,
    // would happily render the rows.
    const page = await dash(GATED);
    expect(page).toContain(`if current_user.role == "agent" do`);
    // Denied ⇒ the loader answers the `:error` sentinel the view's error arm
    // renders — the LiveView shape of the route's 403, not an empty success.
    expect(page).toMatch(/if current_user\.role == "agent" do[\s\S]*?else\n {6}:error\n {4}end/);
  });
});
