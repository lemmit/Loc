import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// shadcnVue@v1 pack pins (vue-frontend-plan.md Slice 7) — the fast-
// suite mirror of the LOOM_VUE_BUILD shadcnVue cases.  Pins the
// source-copy distribution model (components-ui glob + barrel), the
// pack-declared imports flowing into page scripts, and the
// pack-owned operation dialog.
// ---------------------------------------------------------------------------

const SOURCE = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Customer with crudish {
          name: string
          email: string
        }
      }
    }
    ui WebApp with scaffold(subdomains: [Sales]) { }
    storage primary { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primary }
    deployable api { platform: hono, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, design: "shadcnVue@v1", port: 3003 }
  }
`;

async function vueFiles(): Promise<Map<string, string>> {
  const all = await generateSystemFiles(SOURCE);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

describe("shadcnVue pack", () => {
  it("source-copies the ui components + barrel + tailwind shell", async () => {
    const files = await vueFiles();
    expect(files.has("src/components/ui/button.vue")).toBe(true);
    expect(files.has("src/components/ui/dialog.vue")).toBe(true);
    expect(files.has("src/components/ui/index.ts")).toBe(true);
    expect(files.get("src/components/ui/index.ts")).toContain(
      'export { default as Button } from "./button.vue";',
    );
    expect(files.has("src/globals.css")).toBe(true);
    expect(files.has("src/lib/utils.ts")).toBe(true);
    const pkg = JSON.parse(files.get("package.json")!) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["reka-ui"]).toBeTruthy();
    expect(pkg.dependencies.tailwindcss).toBeTruthy();
  });

  it("pack-declared imports flow into the page script via the barrel", async () => {
    const files = await vueFiles();
    const list = files.get("src/pages/customers/list.vue")!;
    expect(list).toMatch(/import \{ .*Button.* \} from "@\/components\/ui";/);
    expect(list).toContain("<Table");
    // The same walker testid contract as every other pack.
    expect(list).toContain('data-testid="customers-list-create"');
  });

  it("operation dialogs render through the pack's op-dialog template", async () => {
    const files = await vueFiles();
    const detail = files.get("src/pages/customers/detail.vue")!;
    expect(detail).toContain('<Dialog v-model:open="updateOpen">');
    expect(detail).toContain("DialogContent");
    expect(detail).toContain('data-testid="customers-op-update-submit"');
    // The dialog's component imports merged from pack.json
    // imports["op-dialog"].
    expect(detail).toMatch(/import \{ .*Dialog, DialogContent.* \} from "@\/components\/ui";/);
  });
});
