// M-T1.1 — `Table` sort / pagination / filter on Feliz.
//
// Feliz was the last frontend rendering a STATIC table: the headers and rows
// emitted, the controls were dropped.  Three things blocked it, and each is
// pinned below:
//
//   1. the client-paging arithmetic was literal JavaScript (`.slice`,
//      `Math.ceil`) built into the shared primitive — now the
//      `renderClientPaging` seam, so F# supplies its own;
//   2. the sort key is a RUNTIME string and an F# record can't be indexed by
//      one — `SortedRowsSpec.columns` carries the sortable field set so the
//      target emits a closed `match` instead;
//   3. the pack rendered the header as `Html.text "<header>"`, which would have
//      emitted a clickable sort button as a string literal — a sortable header
//      is now flagged as MARKUP and goes into the cell's children.
//
// The emitted F# is proven to compile (`dotnet fable`) and to BEHAVE (the
// Playwright `scripts/feliz-table-smoke.mjs`, which asserts rendered rows after
// paging / sorting / filtering) by `generated-feliz-build.yml`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const app = (table: string, state = "") => `
system Shop {
  subdomain S {
    context C {
      aggregate Product with crudish { name: string  qty: int }
      repository Products for Product { }
    }
  }
  api ShopApi from S
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  ui WebApp {
    api Shop: ShopApi
    page Listing {
      route: "/"
      state { sortKey: string = ""  sortDir: string = "asc"  pageNum: int = 1  q: string = "" ${state} }
      body: QueryView { of: Shop.Product.all, data: rows => ${table} }
    }
  }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: ShopApi port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { Shop: api } port: 3005 }
}
`;

async function appFs(table: string, state = ""): Promise<string> {
  const files = await generateSystemFiles(app(table, state));
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

const COLS = `Column("Name", p => p.name, sortable: true), Column("Qty", p => p.qty, sortable: true)`;

describe("feliz Table controls", () => {
  it("collects the control refs into the MVU Model exactly like a bound input", async () => {
    const fs = await appFs(
      `Table(${COLS}, rows: rows, sortKey: sortKey, sortDir: sortDir, page: pageNum, pageSize: 3, filter: q)`,
    );
    // The `Set<Field>` Msg + update arm come from the SAME machinery a
    // `Field(bind:)` uses — `Table` just contributes four refs instead of one.
    expect(fs).toContain("| SetSortKey of string");
    expect(fs).toContain("| SetSortDir of string");
    expect(fs).toContain("| SetPageNum of string");
    expect(fs).toContain("| SetQ of string");
    // `page` is an int field, so its arm carries the shared safe parse.
    expect(fs).toContain(
      "| SetPageNum v -> { model with PageNum = (match System.Int32.TryParse v with | true, n -> n | _ -> 0) }, Cmd.none",
    );
  });

  it("renders a sortable header as a real button, not as header TEXT", async () => {
    const fs = await appFs(`Table(${COLS}, rows: rows, sortKey: sortKey, sortDir: sortDir)`);
    // Markup goes in the cell's children; the string-literal wrap would have
    // emitted the whole button as a label.
    expect(fs).toContain("Html.th [ prop.children [ Html.button [");
    expect(fs).not.toContain('Html.th [ Html.text "Html.button');
    // Re-clicking the ACTIVE column flips direction; a new column selects it and
    // resets to ascending — two Msgs, so that branch dispatches twice.
    expect(fs).toContain(
      'if model.SortKey = "name" then dispatch (SetSortDir (if model.SortDir = "asc" then "desc" else "asc")) ' +
        'else (dispatch (SetSortKey "name"); dispatch (SetSortDir "asc"))',
    );
    // Active-column direction indicator.
    expect(fs).toContain(
      '(if model.SortKey = "name" then (if model.SortDir = "asc" then " ↑" else " ↓") else "")',
    );
  });

  it("sorts through a closed match over the sortable columns, comparing the FIELD", async () => {
    const fs = await appFs(`Table(${COLS}, rows: rows, sortKey: sortKey, sortDir: sortDir)`);
    // One arm per sortable column — an F# record cannot be indexed by the
    // runtime key, and comparing the field (not its string form) is what keeps
    // `qty` ordering numerically.
    expect(fs).toContain(
      'let c = (match model.SortKey with | "name" -> compare a.name b.name | "qty" -> compare a.qty b.qty | _ -> 0) ' +
        'in if model.SortDir = "desc" then -c else c',
    );
    // No JavaScript leaked in.
    expect(fs).not.toContain(".sort((a, b)");
    expect(fs).not.toContain("Math.ceil");
  });

  it("a column with no resolvable field contributes no sort arm", async () => {
    // `p => Money(p.qty)` is a call, not a member — there is no single row
    // property behind it, so the column stays a plain header.
    const fs = await appFs(
      `Table(Column("Name", p => p.name, sortable: true), Column("Qty", p => Money(p.qty), sortable: true), ` +
        `rows: rows, sortKey: sortKey, sortDir: sortDir)`,
    );
    expect(fs).toContain('| "name" -> compare a.name b.name');
    expect(fs).not.toContain("compare a.qty b.qty");
  });

  it("windows the page by INDEX (List.skip would raise past the end) and ceils in ints", async () => {
    const fs = await appFs(`Table(${COLS}, rows: rows, page: pageNum, pageSize: 3)`);
    expect(fs).toContain(
      "|> List.indexed |> List.filter (fun (i, _) -> i >= ((model.PageNum - 1) * 3) && i < model.PageNum * 3) |> List.map snd",
    );
    expect(fs).not.toContain("List.skip");
    // Integer ceiling division — F# has no `Math.ceil` over an int quotient.
    expect(fs).toContain("+ 3 - 1) / 3)");
    // The count is bound once rather than recomputed per pager slot.
    expect(fs).toContain("(let __tp = ");
    expect(fs).toContain('prop.text (sprintf "Page %d of %d" model.PageNum __tp)');
    expect(fs).toContain("prop.disabled (model.PageNum <= 1)");
    expect(fs).toContain("prop.disabled (model.PageNum >= __tp)");
  });

  it("filters over the DISPLAYED columns, case-insensitively", async () => {
    const fs = await appFs(`Table(${COLS}, rows: rows, filter: q)`);
    expect(fs).toContain(
      'let __q = (model.Q).Trim().ToLower() in __q = "" || ' +
        "([ string r.name; string r.qty ] |> List.exists (fun v -> v.ToLower().Contains(__q)))",
    );
    expect(fs).toContain('prop.custom("data-testid", "table-filter")');
  });

  it("wraps the table + its controls in a real container, not adjacent expressions", async () => {
    // Two adjacent F# expressions sequence and discard the first, so a table
    // with siblings has to become a container — `joinRoots`.
    const fs = await appFs(`Table(${COLS}, rows: rows, page: pageNum, pageSize: 3, filter: q)`);
    expect(fs).toContain('Html.div [ prop.className "flex flex-col"; prop.children [ Html.input');
  });

  it("leaves a plain Table byte-identical — no container, no controls", async () => {
    const fs = await appFs(`Table(Column("Name", p => p.name), rows: rows)`);
    expect(fs).toContain('Html.th [ Html.text "Name" ]');
    expect(fs).not.toContain('prop.className "flex flex-col"');
    expect(fs).not.toContain('data-testid", "pager"');
    expect(fs).not.toContain("SetSortKey");
  });

  it("renders a SERVER-paged table plain — controls need an envelope Feliz doesn't decode", async () => {
    // Caught by the CI scaffold app, not by the hand-written showcase: a
    // scaffolded list page IS server-paged, and implementing `renderPager`
    // made it emit `rows.totalPages` — against a plain `'T list`, because the
    // Feliz wire decodes only the envelope's `items`.  `dotnet fable` rejected
    // it outright ("The type 'List<_>' does not define … 'totalPages'").
    //
    // The sortable header would have been the SILENT half of the same bug: it
    // compiles, writes sort state, and nothing refetches on it.  So server mode
    // suppresses both (`serverPagedControls: false`) and renders the plain,
    // server-ORDERED page the backend already sent.
    const fs = await appFs(
      `Table(${COLS}, rows: rows, sortKey: sortKey, sortDir: sortDir, page: pageNum, ` +
        `serverPaged: true, totalPages: 3)`,
    );
    expect(fs).not.toContain("totalPages");
    expect(fs).not.toContain('data-testid", "pager"');
    expect(fs).toContain('Html.th [ Html.text "Name" ]');
    // …and no dead Msg cases either: the refs contribute nothing when no
    // control dispatches them.
    expect(fs).not.toContain("SetSortKey");
    expect(fs).not.toContain("SetPageNum");
  });
});
