// Regression: a Svelte list/table `{#each}` must not iterate a possibly-
// `undefined` query result.
//
// svelte-query's `.data` is typed `T[] | undefined`.  The list/table template
// emitted `{#each orderAll.data as row}`; the `{:else if (… ?? []).length}`
// guard above it does NOT narrow `.data` inside the `{:else}`, so under
// `strict` + `svelte-check --fail-on-warnings` (the generated-svelte-build CI
// gate) the each-block flags "possibly undefined".  The select dropdowns
// already guard with `(… ?? [])`; the list/table now does too.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (design: string) => `
system Shop {
  subdomain Sales {
    context S {
      aggregate Order { sku: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  ui WebApp with scaffold(subdomains: [Sales]) { api Sales: SalesApi }
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: node
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
  deployable web {
    platform: svelte
    targets: api
    ui: WebApp { Sales: api }
    port: 5173
    design: ${design}
  }
}
`;

describe.each([
  "shadcnSvelte",
  "flowbite",
])("svelte (%s) — list each-block guards undefined data", (design) => {
  it("wraps the each iterable in (… ?? []), never a bare query .data", async () => {
    const files = await generateSystemFiles(SRC(design));
    const listPage = [...files.entries()].find(
      ([p]) => /routes\/.*orders.*\+page\.svelte$/.test(p) || /\/orders\/\+page\.svelte$/.test(p),
    )?.[1];
    expect(listPage, "orders list +page.svelte").toBeDefined();
    // The each must iterate a narrowed array, not `T[] | undefined`.  Since
    // M-T1.1 the scaffold list wraps the rows in `sortRows(...)`, but the
    // `(… ?? [])` guard still surrounds it and the bare `.data as` never appears.
    expect(listPage).toMatch(/\{#each \(.*\?\? \[\]\) as /);
    expect(listPage).not.toMatch(/\{#each [\w.]+\.data as /);
  });
});
