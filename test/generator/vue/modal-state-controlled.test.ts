// Feature: state-controlled `Modal { open: <state> }` on the Vue packs
// (vuetify <v-dialog v-model>, shadcnVue <Dialog v-model:open>).
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
  deployable webx { platform: vue targets: api ui: WebApp { Sales: api } port: 5173 design: ${design} }
}
`;

const page = (files: Map<string, string>) =>
  [...files.entries()].find(([p]) => /pages\/confirm\.vue$/.test(p))?.[1];

describe("vue Modal { open: <state> } — state-controlled dialog", () => {
  it("vuetify renders <v-dialog v-model> bound to the state ref", async () => {
    const p = page(await generateSystemFiles(SRC("vuetify")));
    expect(p, "confirm.vue").toBeDefined();
    expect(p).toMatch(/const archiveOpen = ref\(false\);/);
    expect(p).toMatch(/<v-dialog v-model="archiveOpen"/);
    expect(p).toContain("Confirm archive?");
    expect(p).not.toContain("Modal: expects trigger");
  });

  it("shadcnVue renders <Dialog v-model:open> bound to the state ref", async () => {
    const p = page(await generateSystemFiles(SRC("shadcnVue")));
    expect(p, "confirm.vue").toBeDefined();
    expect(p).toMatch(/const archiveOpen = ref\(false\);/);
    expect(p).toMatch(/<Dialog v-model:open="archiveOpen">/);
    expect(p).toContain("Confirm archive?");
    expect(p).not.toContain("Modal: expects trigger");
  });
});
