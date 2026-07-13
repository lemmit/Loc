// Feature: state-controlled `Modal { open: <state> }` on the Svelte packs
// (shadcnSvelte / flowbite — hand-rolled `{#if}` overlay driven by a $state
// rune, matching their op-form modal idiom).
// See docs/old/proposals/state-controlled-modal.md.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = (design: string) => `
system Acme {
  subdomain Sales { context S { aggregate Order { sku: string } repository Orders for Order { } } }
  api SalesApi from Sales
  ui WebApp with scaffold(subdomains: [Sales]) {
    api Sales: SalesApi
    page Confirm {
      route: "/confirm"
      title: "Confirm"
      state { archiveOpen: bool = false }
      body: Stack {
        Button { "Archive", onClick: e => { archiveOpen := true } },
        Modal { Text { "Confirm archive?" }, open: archiveOpen, title: "Archive" }
      }
    }
  }
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api { platform: node contexts: [S] dataSources: [sState] serves: SalesApi port: 3001 }
  deployable webx { platform: svelte targets: api ui: WebApp { Sales: api } port: 5173 design: ${design} }
}
`;

const page = (files: Map<string, string>) =>
  [...files.entries()].find(([p]) => /confirm\/\+page\.svelte$/.test(p))?.[1];

describe.each([
  "shadcnSvelte",
  "flowbite",
])("svelte (%s) Modal { open: <state> } — state-controlled overlay", (design) => {
  it("renders an {#if <state>} overlay driven by the $state rune", async () => {
    const p = page(await generateSystemFiles(SRC(design)));
    expect(p, "confirm +page.svelte").toBeDefined();
    expect(p).toMatch(/let archiveOpen = \$state<boolean>\(false\);/);
    expect(p).toMatch(/\{#if archiveOpen \}/);
    expect(p).toContain("Confirm archive?");
    expect(p).not.toContain("Modal: expects trigger");
  });
});
