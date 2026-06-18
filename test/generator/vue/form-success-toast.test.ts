import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vue form-submit success-toast parity (DEBT-11).
//
// React/Svelte default-submit forms show a success toast on completion;
// Vue used to navigate silently.  The Vue packs' `form-default-onsubmit`
// now pushes a `pushToast(...)` between the mutation and the redirect, so
// a successful create/workflow submit surfaces the same confirmation.
//
// The toast queue (`src/lib/toast.ts`) + the app-shell toast host were
// previously emitted only for realtime `on` handlers; they're now gated
// on `realtime || forms` so a form-only project still mounts a host for
// its toast to land in.  Error handling is unchanged — `useLoomForm`
// already maps server/validation errors onto the form (inline alert).
// ---------------------------------------------------------------------------

async function vueFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

const sys = (pageBody: string, design = "") => `
  system S {
    subdomain M { context C {
      aggregate Order { name: string }
      repository Orders for Order { }
      workflow placeOrder {
        create(customerName: string, quantity: int) {
          let order = Order.create({ name: customerName })
        }
      }
    } }
    api Api from M
    ui WebApp {
      page Run { route: "/run" body: ${pageBody} }
    }
    deployable api { platform: node, contexts: [C], serves: Api, port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, port: 3003${design ? `, design: "${design}"` : ""} }
  }
`;

describe.each(["vuetify@v3", "shadcnVue@v1"])("Vue form success toast — %s", (design) => {
  it("workflow form: success toast between run + redirect, with the pushToast import", async () => {
    const files = await vueFiles(sys(`Stack { WorkflowForm { runs: placeOrder } }`, design));
    const page = files.get("src/pages/run.vue")!;
    expect(page).toContain(`import { pushToast } from "../lib/toast";`);
    expect(page).toContain(
      `await run.mutateAsync(vals); pushToast("Place Order completed"); navigate("/workflows");`,
    );
  });

  it("create form: success toast between create + redirect", async () => {
    const files = await vueFiles(sys(`Stack { CreateForm { of: Order } }`, design));
    const page = files.get("src/pages/run.vue")!;
    expect(page).toContain(`import { pushToast } from "../lib/toast";`);
    expect(page).toContain(`pushToast("Order created");`);
  });

  it("a form mounts the toast queue + app-shell host even with no realtime channels", async () => {
    const files = await vueFiles(sys(`Stack { CreateForm { of: Order } }`, design));
    expect(files.get("src/lib/toast.ts")).toContain("export function pushToast(");
    const app = files.get("src/App.vue")!;
    expect(app).toContain('data-testid="channel-toast-host"');
    expect(app).toMatch(/import \{ toastQueue \} from "[@.][^"]*\/lib\/toast";/);
  });

  it("a form-free, realtime-free page emits no toast queue or host", async () => {
    const files = await vueFiles(sys(`Heading { "hi" }`, design));
    expect(files.has("src/lib/toast.ts")).toBe(false);
    expect(files.get("src/App.vue")).not.toContain("channel-toast-host");
    expect(files.get("src/pages/run.vue")).not.toContain("pushToast");
  });
});
