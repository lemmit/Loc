// Vuetify pack a11y backfill — the fixes the extended axe gate
// (generated-a11y.yml, `LOOM_A11Y_PACK=vuetify@v3`) surfaced on first run.
// axe runs nightly/label-gated, so these fast markup assertions pin the fixes
// per-PR so a template edit can't silently reintroduce a WCAG-AA regression.
//
// Three violations were fixed in `designs/vuetify/v3/`:
//   1. aria-required-children — the nav `<v-list>` renders `role="list"` but
//      its `<v-list-item :to>` children render `role="link"`, not listitem.
//      `role="none"` drops the list role (the nav landmark carries the
//      semantics, mirroring the roleless Mantine nav that already passes axe).
//   2. list (<ul> must only contain <li>) — `<v-breadcrumbs>` renders a `<ul>`
//      whose walker-emitted children are raw `<a>`/`<div>`, not `<li>`.  The
//      breadcrumb is now a `<nav aria-label="Breadcrumb">` landmark.
//   3. color-contrast — Vuetify's default field label (#7a7a7a, 4.29:1 on
//      white) is darkened to clear the 4.5:1 AA floor.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Customer with crudish { name: string  email: string }
    }
  }
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  ui WebApp with scaffold(subdomains: [Sales]) { }
  deployable api { platform: node contexts: [Orders] dataSources: [st] port: 8080 }
  deployable web { platform: vue targets: api ui: WebApp design: "vuetify@v3" port: 3001 }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("vuetify pack — a11y backfill", () => {
  it("the nav v-list drops role=list (aria-required-children) and keeps the nav landmark", async () => {
    const shell = find(await generateSystemFiles(SYS), "/App.vue");
    // The drawer stays a named navigation landmark…
    expect(shell).toContain('aria-label="Primary navigation"');
    // …but the inner list is presentational so its link children don't trip
    // aria-required-children (role=list requires role=listitem children).
    expect(shell).toContain('<v-list density="compact" nav role="none" data-testid="nav-sidebar">');
  });

  it("darkens the field label to clear AA contrast", async () => {
    const shell = find(await generateSystemFiles(SYS), "/App.vue");
    expect(shell).toContain(".v-field-label{color:#616161 !important;opacity:1 !important}");
  });

  it("renders breadcrumbs as a nav landmark, not a <v-breadcrumbs> <ul>", async () => {
    const files = await generateSystemFiles(SYS);
    const listPage = find(files, "/pages/customers/list.vue");
    expect(listPage).toContain('<nav aria-label="Breadcrumb"');
    expect(listPage).toContain("loom-breadcrumbs");
    // The <ul>-rendering Vuetify component is gone (that was the `list` violation).
    expect(listPage).not.toContain("<v-breadcrumbs");
  });
});
