import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Forms inside user components — Vue.
//
// A `component` whose body hosts a `CreateForm { of: <Agg> }` or
// `WorkflowForm { runs: <wf> }` emits the same `useLoomForm` + mutation
// wiring the page shell does (no route dependency, so it transplants
// verbatim).  Operation forms (Action dialogs) need the page's
// route-derived id + the pack op-dialog host, so they stay a narrow
// deferral.
// ---------------------------------------------------------------------------

async function vueFiles(src: string): Promise<Map<string, string>> {
  const all = await generateSystemFiles(src);
  const out = new Map<string, string>();
  for (const [p, c] of all) {
    if (p.startsWith("web/")) out.set(p.slice("web/".length), c);
  }
  return out;
}

const sys = (uiBody: string, extra = "") => `
  system S {
    subdomain M { context C {
      aggregate Customer with crudish { name: string  email: string }
      ${extra}
    } }
    api Api from M
    ui WebApp {
      api C: Api
${uiBody}
    }
    deployable api { platform: node, contexts: [C], serves: Api, port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp { C: api }, port: 3001 }
  }
`;

describe("forms inside user components — Vue", () => {
  it("a create-form component wires useLoomForm + the create mutation", async () => {
    const files = await vueFiles(
      sys(`
      component NewCustomer() { body: Card { CreateForm { of: Customer, testid: "cust-new" } } }
      page Home { route: "/" body: NewCustomer() }`),
    );
    const comp = files.get("src/components/NewCustomer.vue")!;
    expect(comp).toContain('import { useLoomForm } from "../lib/form";');
    expect(comp).toContain(
      'import { CreateCustomerRequest, useCreateCustomer } from "../api/customer";',
    );
    expect(comp).toContain("const create = reactive(useCreateCustomer());");
    expect(comp).toContain("const form = useLoomForm(CreateCustomerRequest,");
    // The pack form markup is present, bound to the form instance.
    expect(comp).toContain('v-model="form.values.name"');
    expect(comp).toContain('data-testid="cust-new-submit"');
    // Default submit pushes a success toast → the component imports
    // pushToast and the app-shell mounts the toast host even with no
    // realtime channels.
    expect(comp).toContain('import { pushToast } from "../lib/toast";');
    expect(comp).toContain('pushToast("Customer created");');
    expect(files.get("src/lib/toast.ts")).toBeDefined();
    expect(files.get("src/App.vue")).toContain('data-testid="channel-toast-host"');
  });

  it("an operation form inside a component wires the op-dialog (instance from a prop)", async () => {
    const files = await vueFiles(`
      system S {
        subdomain M { context C {
          aggregate Order { customerId: string  derived display: string = customerId  operation confirm() { } }
          repository Orders for Order { }
        } }
        api Api from M
        ui WebApp {
          api C: Api
          component OrderPanel(order: Order) {
            body: Modal { OperationForm { order.confirm }, trigger: Button { "Confirm" }, title: "Confirm" }
          }
          page Home { route: "/" body: Heading { "hi" } }
        }
        deployable api { platform: node, contexts: [C], serves: Api, port: 3000 }
        deployable web { platform: vue, targets: api, ui: WebApp { C: api }, port: 3001 }
      }`);
    const comp = files.get("src/components/OrderPanel.vue")!;
    // The mutation hook's instance idExpr reads off the prop, not a route param.
    expect(comp).toContain("const confirm = reactive(useConfirmOrder(props.order.id));");
    expect(comp).toContain("const confirmOpen = ref(false);");
    expect(comp).toContain("const confirmForm = useLoomForm(ConfirmOrderRequest,");
    // The pack op-dialog host is appended after the body.
    expect(comp).toContain('<v-dialog v-model="confirmOpen"');
    expect(comp).toContain('@click="openConfirmModal(confirm)"');
  });
});
