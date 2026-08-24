import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// M-T1.1 slice 8 (HEEx leg) — server-driven Table sort + pagination.
//
// The four JSX frontends sort/slice a bound array in the BROWSER.  Phoenix
// can't: a LiveView calls its context function directly, so sort/page are
// arguments to the repository's paged `list/4` and a control click re-runs the
// query.  These tests pin the three halves that have to agree:
//
//   1. the LOAD  — `list_<agg>s/4` actually receives the page/sort assigns
//                  (dropping them silently pinned every list to page 1);
//   2. the MARKUP — sortable headers + a pager that write those assigns;
//   3. the HANDLERS — `handle_event` clauses that update state and reload.
//
// Plus the gate: a Table asking for no controls emits byte-identical output.
// ---------------------------------------------------------------------------

/** Scaffolded list page — `scaffold` synthesises the paged `all` QueryView,
 *  the sortable columns and the `pageNum`/`sortKey`/`sortDir` state. */
const SCAFFOLD_SRC = `
system Shop {
  subdomain M {
    context C {
      aggregate Product {
        sku: string
        name: string
        derived display: string = sku
      }
      repository Products for Product { }
    }
  }
  api ShopApi from M
  ui ShopUi with scaffold(subdomains: [M]) { }
  storage loomDb { type: postgres }
  resource cState { for: C, kind: state, use: loomDb }
  deployable phoenixApp {
    platform: elixir, contexts: [C], dataSources: [cState], serves: ShopApi,
    ui: ShopUi, port: 4000
  }
}
`;

/** A hand-written page whose Table asks for NO interactive controls — the
 *  byte-identical gate. */
const PLAIN_SRC = `
system Shop {
  subdomain M {
    context C {
      aggregate Product {
        sku: string
        derived display: string = sku
      }
      repository Products for Product { }
    }
  }
  api ShopApi from M
  ui ShopUi {
    page Listing {
      route: "/listing"
      body: QueryView(
        of: ShopApi.Product.all,
        data: rows => Table(Column("Sku", o => o.sku), rows: rows)
      )
    }
  }
  storage loomDb { type: postgres }
  resource cState { for: C, kind: state, use: loomDb }
  deployable phoenixApp {
    platform: elixir, contexts: [C], dataSources: [cState], serves: ShopApi,
    ui: ShopUi, port: 4000
  }
}
`;

async function liveView(src: string, file: string): Promise<string> {
  const files = await generateSystemFiles(src);
  for (const [p, c] of files) {
    if (p.endsWith(`/${file}`)) return c;
  }
  throw new Error(`${file} not found in: ${[...files.keys()].join(", ")}`);
}

async function coreComponents(src: string): Promise<string> {
  const files = await generateSystemFiles(src);
  for (const [p, c] of files) {
    if (p.endsWith("/core_components.ex")) return c;
  }
  throw new Error("core_components.ex not found");
}

describe("HEEx table controls — the load", () => {
  it("threads the page/sort assigns into the paged list query", async () => {
    const live = await liveView(SCAFFOLD_SRC, "product_list_live.ex");
    // Handler position — the load block is a function body, so state refs must
    // be `socket.assigns.x`, never the template's `@x` (which would resolve to
    // a module attribute and not compile).
    expect(live).toContain(
      "list_products(socket.assigns.page_num, 10, socket.assigns.sort_key, socket.assigns.sort_dir)",
    );
    // The regression this closes: a bare call takes `list/4`'s defaults and
    // pins the list to page 1 forever.
    expect(live).not.toContain("list_products()");
  });

  it("seeds the 1-based page from the state field's declared init, not the type zero", async () => {
    const live = await liveView(SCAFFOLD_SRC, "product_list_live.ex");
    // `pageNum: int = 1`.  Seeding the int zero would drive
    // `offset = (page - 1) * page_size` to -10, which Ecto rejects.
    expect(live).toContain("|> assign(:page_num, 1)");
    expect(live).not.toContain("|> assign(:page_num, 0)");
  });
});

describe("HEEx table controls — the markup", () => {
  it("passes the active sort to the table and marks sortable columns", async () => {
    const live = await liveView(SCAFFOLD_SRC, "product_list_live.ex");
    expect(live).toContain('<.table id="data-table" sort_key={@sort_key} sort_dir={@sort_dir}');
    // Each scaffold column is sortable, keyed by the row field it reads.
    expect(live).toContain('sort_field="sku"');
    expect(live).toContain('sort_field="name"');
  });

  it("renders a pager reading the envelope's camelCase totalPages", async () => {
    const live = await liveView(SCAFFOLD_SRC, "product_list_live.ex");
    // The paged envelope keys are the shared camelCase WIRE names, not snake
    // Elixir idiom — `@items.total_pages` would raise KeyError at render time.
    expect(live).toContain("<.pager page={@page_num} total_pages={@items.totalPages} />");
    expect(live).not.toContain("total_pages={@items.total_pages}");
  });
});

describe("HEEx table controls — the handlers", () => {
  it("toggles direction, resets to page 1, and reloads on sort", async () => {
    const live = await liveView(SCAFFOLD_SRC, "product_list_live.ex");
    expect(live).toContain('def handle_event("loom-sort", %{"key" => key}, socket) do');
    // Re-clicking the sorted column flips asc→desc; a new column starts asc.
    expect(live).toContain(
      'if socket.assigns.sort_key == key and socket.assigns.sort_dir == "asc"',
    );
    // A sort change must reset the page — otherwise a re-sort while deep in
    // the list strands the user on a page that may no longer exist.
    const sortClause = live.slice(live.indexOf('"loom-sort"'), live.indexOf('"loom-page"'));
    expect(sortClause).toContain("|> assign(:page_num, 1)");
    // …and re-runs the query so the new order actually takes effect.
    expect(sortClause).toContain("list_products(socket.assigns.page_num");
  });

  it("clamps the page and reloads on paging", async () => {
    const live = await liveView(SCAFFOLD_SRC, "product_list_live.ex");
    expect(live).toContain('def handle_event("loom-page", %{"page" => page}, socket) do');
    // The payload is client input: a non-numeric or out-of-range page must fall
    // back to 1, not raise (`String.to_integer/1` would) and not drive a
    // negative OFFSET.
    expect(live).toContain("case Integer.parse(to_string(page)) do");
    expect(live).toContain("{n, _} when n > 0 -> n");
    expect(live).toContain("assign(socket, :page_num, page_num)");
    const pageClause = live.slice(live.indexOf('"loom-page"'));
    expect(pageClause).toContain("list_products(socket.assigns.page_num");
  });
});

describe("HEEx table controls — the CoreComponents surface", () => {
  it("declares the sort slot attr and renders a keyboard-focusable header button", async () => {
    const cc = await coreComponents(SCAFFOLD_SRC);
    expect(cc).toContain("attr :sort_field, :string");
    // A real <button>, not a <span onClick> — the same a11y call slice 5 made
    // for the JSX targets (keyboard focus + implicit ARIA role).
    expect(cc).toContain('phx-click="loom-sort"');
    expect(cc).toContain("phx-value-key={col[:sort_field]}");
    // Screen-reader sort state.
    expect(cc).toContain("aria-sort={sort_aria(col[:sort_field], @sort_key, @sort_dir)}");
    expect(cc).toContain("defp sort_aria(nil, _key, _dir), do: nil");
  });

  it("emits a pager component with disabled ends", async () => {
    const cc = await coreComponents(SCAFFOLD_SRC);
    expect(cc).toContain("def pager(assigns) do");
    expect(cc).toContain("disabled={@page <= 1}");
    expect(cc).toContain("disabled={@page >= @total_pages}");
    expect(cc).toContain('phx-click="loom-page"');
  });
});

describe("HEEx table controls — gated off", () => {
  it("a Table with no control args renders plain, with no handlers or pager", async () => {
    const live = await liveView(PLAIN_SRC, "listing_live.ex");
    expect(live).toContain("<.table ");
    // No control args ⇒ none of the new emission fires.
    expect(live).not.toContain("sort_key={");
    expect(live).not.toContain("sort_field=");
    expect(live).not.toContain("<.pager");
    expect(live).not.toContain("loom-sort");
    expect(live).not.toContain("loom-page");
  });
});
