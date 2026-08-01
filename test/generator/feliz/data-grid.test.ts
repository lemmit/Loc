// Feliz `DataGrid` — the F# half of the `renderDataGridChild` seam
// (M-T1.1 slice 10e).
//
// These pin the SHAPE of the emitted F#.  They cannot prove the grid works —
// the row model is `@tanstack/table-core` reached through Fable interop, and
// every way that binding can be wrong (a partial `state`, a detached method, a
// missing thunk) compiles cleanly and fails only in a browser.  That half is
// `scripts/feliz-data-grid-smoke.mjs`, run against a real `dotnet fable` +
// `vite build` bundle by `generated-feliz-build.yml`.  What lives here is the
// structural contract those runtime assertions depend on.

import { describe, expect, it } from "vitest";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const SYS = (
  grid: string,
  state = "state { selectedIds: string[] }",
  sibling = "Text { `Selected: {selectedIds.length}` },",
) => `
system P {
  subdomain S {
    context C {
      enum Tier { Bronze, Silver, Gold }
      aggregate Customer { name: string  sequence: int  tier: Tier }
      repository Customers for Customer { }
    }
  }
  api SalesApi from S
  storage pg { type: postgres }
  ui WebApp {
    framework: feliz
    api Sales: SalesApi
    page Grid {
      route: "/grid"
      ${state}
      body: Stack {
        ${sibling}
        QueryView { of: Sales.Customer.all, data: rows => ${grid} }
      }
    }
  }
  deployable api { platform: node contexts: [C] serves: SalesApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3005 }
}`;

const FULL = `DataGrid(
          Column("Name", o => o.name, sortable: true, filterable: true),
          Column("Sequence", o => o.sequence, sortable: true),
          Column("Tier", o => EnumBadge { o.tier }),
          rows: rows,
          selection: selectedIds,
          multiSort: true,
          columnVisibility: true,
          pageSize: 25,
          testid: "customers-grid")`;

async function emit(src: string): Promise<Map<string, string>> {
  const model = await buildLoomModel(src);
  const sys = model.systems[0]!;
  const web = sys.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(sys.contexts ?? [], sys, web);
}

const appFs = async (src: string): Promise<string> => (await emit(src)).get("src/App.fs")!;

describe("feliz DataGrid (M-T1.1 slice 10e)", () => {
  it("binds the real @tanstack/table-core, not a hand-rolled row model", async () => {
    const fs = await appFs(SYS(FULL));
    // The imports are what make this the SAME row model the JSX frontends run.
    for (const fn of [
      "createTable",
      "getCoreRowModel",
      "getSortedRowModel",
      "getFilteredRowModel",
      "getPaginationRowModel",
    ]) {
      expect(fs).toContain(`[<Fable.Core.Import("${fn}", "@tanstack/table-core")>]`);
    }
    // No re-implementation crept in: the sort toggle goes through TanStack's own
    // handler (the one that reads `shiftKey` for multi-sort).
    expect(fs).toContain("getToggleSortingHandler()");
  });

  it("merges table-core's default state — the partial-state crash guard", async () => {
    const fs = await appFs(SYS(FULL));
    // `getState()` returns the raw `state` option, so a state carrying only our
    // slices throws inside `getHeaderGroups()`.  This is the whole reason the
    // grid renders at all; a regression here is silent until a browser runs it.
    expect(fs).toContain("loomMergeState defaultState ownState");
    expect(fs).toContain("?initialState");
  });

  it("emits a [<ReactComponent>] child at module scope, before the page views", async () => {
    const fs = await appFs(SYS(FULL));
    expect(fs).toContain("[<ReactComponent>]");
    expect(fs).toContain("let CustomersGrid (rows: obj array)");
    // F# is order-sensitive — the declaration must precede the view that calls it.
    expect(fs.indexOf("let CustomersGrid")).toBeLessThan(fs.indexOf("let view "));
  });

  it("projects rows at the CALL SITE, so no DTO type name reaches the child", async () => {
    const fs = await appFs(SYS(FULL));
    expect(fs).toContain("|> List.mapi (fun __i row ->");
    // accessorKey columns carry the raw typed field...
    expect(fs).toContain('"name" ==> box row.name');
    expect(fs).toContain('"sequence" ==> box row.sequence');
    // ...and a computed column carries a LAZY markup thunk instead.
    expect(fs).toContain('"loom-cell-col3" ==> box (fun () ->');
    // The child itself is typed `obj array` — it never names `Customer`.
    expect(fs).not.toContain("(rows: Customer list)");
  });

  it("routes `selection:` through the Elmish Msg, not a direct state write", async () => {
    const fs = await appFs(SYS(FULL));
    // Feliz's `renderStateWrite` is a no-op (state lives in `update`), so the
    // grid must dispatch.  The Msg case + arm come from BOUND_INPUT_PRIMITIVES.
    expect(fs).toContain("dispatch (SetSelectedIds __ids)");
    expect(fs).toContain("| SetSelectedIds of string list");
    expect(fs).toContain("| SetSelectedIds v -> { model with SelectedIds = v }, Cmd.none");
  });

  it("adds @tanstack/table-core to package.json only when a grid exists", async () => {
    const withGrid = await emit(SYS(FULL));
    expect(withGrid.get("package.json")).toContain('"@tanstack/table-core"');

    const withoutGrid = await emit(
      SYS(`Table(Column("Name", o => o.name), rows: rows)`, "state { }", ""),
    );
    expect(withoutGrid.get("package.json")).not.toContain("@tanstack/table-core");
    expect(withoutGrid.get("src/App.fs")).not.toContain("loomCreateTable");
  });

  it("drops the state slices a grid did not ask for", async () => {
    // No selection, no filterable column, no columnVisibility → none of those
    // hooks, handlers or row models are emitted (smaller output, no dead state).
    const fs = await appFs(
      SYS(`DataGrid(Column("Name", o => o.name, sortable: true), rows: rows)`, "state { }", ""),
    );
    expect(fs).toContain("let sorting, setSorting");
    expect(fs).not.toContain("let rowSelection");
    expect(fs).not.toContain("let columnFilters");
    expect(fs).not.toContain("let columnVisibility");
    // The interop PRELUDE always declares all five bindings (it is shared by
    // every grid in the module); what must be absent is the OPTION that turns
    // the filtered row model on.
    expect(fs).not.toContain('"getFilteredRowModel" ==>');
    // Pagination is ALWAYS controlled — an uncontrolled pageIndex would reset
    // to 0 on every sort click.
    expect(fs).toContain("let pagination, setPagination");
  });

  it("an `array.length` read spells F#'s .Length and coerces in an interpolation", async () => {
    const fs = await appFs(SYS(FULL));
    // The sibling that makes `selection:` worth having.  `.length` is the JS
    // spelling and `"…" + int` is an F# type error — both would fail `dotnet
    // fable`, neither is visible to a DOM assertion.
    expect(fs).toContain('("Selected: " + (string (model.SelectedIds.Length)))');
  });
});
