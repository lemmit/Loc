// shadcn-vue pack a11y backfill — the form-label association the extended axe
// gate (generated-a11y.yml, `LOOM_A11Y_PACK=shadcnVue@v1`) surfaced.
//
// shadcn-vue renders form fields as `<Label>…</Label><Input …/>` — but the
// `<Label>` had no `for` and the `<Input>` no `id`, so nothing associated the
// visible label with the control (axe `label`, critical: "Element does not have
// an implicit (wrapped) <label>… no explicit <label>… no aria-label"). Every
// `field-input-*` template now threads the field's stable `testId` as `for` on
// the label and `id` on the focusable control (Input / Switch / SelectTrigger),
// which the shadcn `<Label>`/`<Input>` components forward to their native root.
// The sibling shadcnSvelte pack already did this (plain `for`/`id`) and passes.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Customer with crudish { name: string  count: int  active: bool }
    }
  }
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  ui WebApp with scaffold(subdomains: [Sales]) { }
  deployable api { platform: node contexts: [Orders] dataSources: [st] port: 8080 }
  deployable web { platform: vue targets: api ui: WebApp design: "shadcnVue@v1" port: 3001 }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("shadcn-vue pack — form-label association (a11y)", () => {
  it("a string field's Label carries for= and its Input the matching id=", async () => {
    const page = find(await generateSystemFiles(SYS), "/pages/customers/new.vue");
    // The label's `for` and the input's `id` must both resolve to the field's
    // testId, so the visible label names the control for assistive tech.
    expect(page).toContain('<Label for="customers-new-input-name">Name</Label>');
    expect(page).toContain('<Input id="customers-new-input-name"');
  });

  it("a numeric field is associated too", async () => {
    const page = find(await generateSystemFiles(SYS), "/pages/customers/new.vue");
    expect(page).toContain('<Label for="customers-new-input-count">Count</Label>');
    expect(page).toContain('<Input id="customers-new-input-count"');
  });

  it("a boolean field associates the Switch via id", async () => {
    const page = find(await generateSystemFiles(SYS), "/pages/customers/new.vue");
    expect(page).toContain('<Label for="customers-new-input-active">Active</Label>');
    expect(page).toContain('<Switch id="customers-new-input-active"');
  });
});
