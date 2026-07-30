// `loom.datagrid-unsupported-target` — DataGrid on a frontend that can't
// render it is a COMPILE ERROR, not a silently missing grid.
//
// This is the honest-gap discipline: DataGrid emits a hook-bearing TanStack
// child component, so it is not a markup mapping the other frontends pick up
// for free.  Without this gate a Vue/Svelte/Angular/Feliz/Flutter page would
// render an empty slot (or a "not supported" comment on HEEx) and the author
// would only discover it in the running app.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseValid } from "../_helpers/index.js";

async function validateSource(src: string) {
  return validateLoomModel(enrichLoomModel(lowerModel(await parseValid(src))));
}

/** `platform:` for a ui's host.  The four static-bundle frameworks share the
 *  `static` host; Feliz and Flutter each only host their own (they build through
 *  their own toolchains), so the validator rejects them on `static`. */
const hostFor = (framework: string): string =>
  framework === "feliz" || framework === "flutter" ? framework : "static";

const sys = (framework: string): string => `
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
    framework: ${framework}
    api Sales: SalesApi
    page X { route: "/x"  body: QueryView { of: Sales.Customer.all, data: rows => DataGrid(
      Column("Name", o => o.name, sortable: true),
      rows: rows) } }
  }
  deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
  deployable web { platform: ${hostFor(framework)}, targets: api, port: 3001, ui: WebApp { Sales: api } }
}
`;

describe("loom.datagrid-unsupported-target", () => {
  // The frameworks with no `renderDataGridChild` seam.  Feliz emits F#/Elmish
  // and Flutter emits Dart — neither has a TanStack adapter, and neither rides
  // the shared `walkBody` markup engine the four JS targets share.
  for (const fw of ["feliz", "flutter"]) {
    it(`rejects DataGrid on a ${fw} frontend`, async () => {
      const diags = await validateSource(sys(fw));
      const hit = diags.find((d) => d.code === "loom.datagrid-unsupported-target");
      expect(hit, `expected the gate to fire for ${fw}`).toBeDefined();
      expect(hit?.severity).toBe("error");
      // The message must point at the alternative that actually works.
      expect(hit?.message).toContain("Table");
    });
  }

  // Ported frameworks.  Each entry here is a `renderDataGridChild` seam that
  // exists; the gate's whole job is to keep the two sets in step.
  for (const fw of ["react", "vue", "svelte", "angular"]) {
    it(`accepts DataGrid on ${fw}`, async () => {
      const diags = await validateSource(sys(fw));
      expect(diags.find((d) => d.code === "loom.datagrid-unsupported-target")).toBeUndefined();
    });
  }
});
