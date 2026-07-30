// `loom.datagrid-selection-not-state` / `loom.datagrid-selection-not-array` —
// the two halves of `DataGrid(selection: <field>)` the WALKER cannot check.
//
// The walker wires selection by NAME: it emits `onSelectionChange={set<Field>}`
// against the page shell's `useState` for that field.  It sees only the set of
// declared state NAMES, so:
//
//   - a ref that isn't a state field is silently DROPPED (the checkbox column
//     vanishes with no explanation — the ref might be a page param or a typo);
//   - a wrongly-typed field compiles into `setPicked(<string[]>)` against e.g.
//     `useState<string>`, surfacing as a tsc error in GENERATED code, far from
//     its cause in the `.ddd`.
//
// Both are gated at IR-validate, where the declared `TypeIR` is resolved and
// the diagnostic can name the field.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/index.js";

async function validateSource(src: string) {
  return validateLoomModel(enrichLoomModel(lowerModel(await parseValid(src))));
}

/** A react system whose page declares `state { <stateDecl> }` and binds
 *  `selection: <bind>` on a DataGrid. */
const sys = (stateDecl: string, bind: string): string => `
system S {
  subdomain Sales {
    context Orders {
      aggregate Customer { name: string  tier: int }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  storage pg { type: postgres }
  ui WebApp {
    framework: react
    api Sales: SalesApi
    page X {
      route: "/x"
      state { ${stateDecl} }
      body: Stack(
        Text("n: {picked}"),
        QueryView { of: Sales.Customer.all, data: rows => DataGrid(
          Column("Name", o => o.name, sortable: true),
          rows: rows, selection: ${bind}) })
    }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: static, targets: api, port: 3001, ui: WebApp { Sales: api } }
}
`;

describe("DataGrid selection — state binding", () => {
  it("accepts a `string[]` state field", async () => {
    const diags = await validateSource(sys("picked: string[]", "picked"));
    expect(diags.filter((d) => d.code.startsWith("loom.datagrid-selection"))).toEqual([]);
  });

  it("rejects a ref that isn't a declared state field", async () => {
    const diags = await validateSource(sys("picked: string[]", "pickd"));
    const hit = diags.find((d) => d.code === "loom.datagrid-selection-not-state");
    expect(hit?.severity).toBe("error");
    // Names the offending ref and the fix.
    expect(hit?.message).toContain("'pickd'");
    expect(hit?.message).toContain("state { selectedIds: String[] }");
    expect(hit?.source).toBe("page 'X'");
  });

  it("rejects a non-array state field, naming its declared type", async () => {
    const diags = await validateSource(sys("picked: string", "picked"));
    const hit = diags.find((d) => d.code === "loom.datagrid-selection-not-array");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain("'picked'");
    expect(hit?.message).toContain("string");
  });

  it("rejects an array of the wrong element type", async () => {
    // `int[]` would emit `setPicked(ids: string[])` against `useState<number[]>`.
    const diags = await validateSource(sys("picked: int[]", "picked"));
    expect(diags.find((d) => d.code === "loom.datagrid-selection-not-array")).toBeDefined();
  });

  it("stays quiet when the grid declares no `selection:`", async () => {
    const src = sys("picked: string[]", "picked").replace(", selection: picked", "");
    const diags = await validateSource(src);
    expect(diags.filter((d) => d.code.startsWith("loom.datagrid-selection"))).toEqual([]);
  });
});
