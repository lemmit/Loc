import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Vue walker — walked-page output pins (vue-frontend-plan.md Slice 4).
// The scaffold pages walk through the SHARED markup walker with
// `vueTarget` + the vuetify pack; these tests pin the load-bearing
// Vue-isms: mustache interpolation, v-for/v-if control flow from the
// pack templates, single-quoted JS-splicing attributes, reactive()-
// wrapped vue-query handles, and the op-form stub wiring.  They are
// the fast-suite mirror of the LOOM_VUE_BUILD vue-tsc gate.
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
    deployable api { platform: node, contexts: [Orders], dataSources: [ordersState], port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
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

describe("vue walker — scaffold pages", () => {
  it("list page: reactive() vue-query hoist + mustache cells + v-for rows", async () => {
    const files = await vueFiles();
    const list = files.get("src/pages/customers/list.vue")!;
    // Script: composable hoisted once, wrapped in reactive() so
    // nested refs (`.data`, `.isLoading`) unwrap in template position.
    // `ref` joins the import for the M-T1.1 client-side sort state.
    expect(list).toContain(`import { reactive, ref } from "vue";`);
    expect(list).toContain("const customerAll = reactive(useAllCustomers());");
    // Template: pack-owned v-if query arms + v-for rows + mustaches.
    expect(list).toContain('<template v-if="customerAll.isLoading">');
    // The scaffold list sorts + paginates client-side, so rows flow through
    // `sortRows(...)` then a `.slice(...)` page window.
    expect(list).toContain(
      'v-for="(row) in (sortRows(customerAll.data, sortKey, sortDir)).slice((pageNum - 1) * 10, pageNum * 10)"',
    );
    expect(list).toContain("{{ row.name }}");
    expect(list).toContain("{{ shortId(row.id) }}");
    // JS-splicing attributes are single-quoted (the rendered JS
    // carries double-quoted string literals).
    expect(list).toContain(`@click='() => navigate("/customers/new")'`);
    expect(list).toContain(`:data-testid='("customers-row-" + row.id)'`);
    // The navigate adapter bridges the walker's Button(to:) contract.
    expect(list).toContain("const navigate = (to: string) => { void router.push(to); };");
  });

  it("detail page: route param + byId handle + operation dialog wiring", async () => {
    const files = await vueFiles();
    const detail = files.get("src/pages/customers/detail.vue")!;
    expect(detail).toContain("const route = useRoute();");
    expect(detail).toContain("const id = route.params.id as string;");
    expect(detail).toContain("const customerById = reactive(useCustomerById(id));");
    expect(detail).toContain("{{ customerById.data.name }}");
    // Operation form: real mutation handle, dialog state, per-op
    // LoomForm instance, and the appended v-dialog.
    expect(detail).toContain(`const update = reactive(useUpdateCustomer(id ?? ""));`);
    expect(detail).toContain("const updateOpen = ref(false);");
    expect(detail).toContain(
      "const openUpdateModal = (_mut: unknown) => { updateOpen.value = true; };",
    );
    expect(detail).toContain(
      'const updateForm = useLoomForm(UpdateCustomerRequest, { name: "", email: "" });',
    );
    expect(detail).toContain('<v-dialog v-model="updateOpen"');
    // Field markup re-pointed at the dialog's form instance.
    expect(detail).toContain('v-model="updateForm.values.name"');
    expect(detail).toContain(`:error-messages='updateForm.errors["name"]'`);
    expect(detail).toContain('data-testid="customers-op-update-form"');
    expect(detail).toContain('data-testid="customers-op-update-submit"');
  });

  it("magic route id: a hand-written byId(id) page binds id from route.params", async () => {
    // The bare `id` magic identifier (NOT a declared param) used to render
    // `/* unsupported expr: id */ undefined`, so the byId read never fetched.
    const all = await generateSystemFiles(`
      system S {
        api SalesApi from Sales
        subdomain Sales {
          context Orders {
            aggregate Order { customerId: string }
            repository Orders for Order { find byId(id: string): Order? }
          }
        }
        ui WebApp {
          api Sales: SalesApi
          page OrderDetail {
            route: "/orders/:id"
            body: QueryView { of: Sales.Order.byId(id), single: true, data: o => Text { o.customerId } }
          }
        }
        deployable api { platform: node, contexts: [Orders], port: 3000 }
        deployable web { platform: vue, targets: api, ui: WebApp, port: 3003 }
      }
    `);
    const detail = all.get("web/src/pages/order_detail.vue")!;
    expect(detail).not.toContain("unsupported expr: id");
    expect(detail).toContain("const id = route.params.id as string;");
    expect(detail).toContain("const orderById = reactive(useOrderById(id));");
  });

  it("new page: create form wired through useLoomForm + reactive mutation handle", async () => {
    const files = await vueFiles();
    const newPage = files.get("src/pages/customers/new.vue")!;
    expect(newPage).toContain(`import { useLoomForm } from "../../lib/form";`);
    // Default-submit create form imports the toast queue for its success toast.
    expect(newPage).toContain(`import { pushToast } from "../../lib/toast";`);
    expect(newPage).toContain("const create = reactive(useCreateCustomer());");
    expect(newPage).toContain(
      'const form = useLoomForm(CreateCustomerRequest, { name: "", email: "" });',
    );
    // The pack's v-form markup: zod-parsed submit with the default
    // create-then-redirect body (success toast then redirect), single-
    // quoted handler attr.
    expect(newPage).toContain(
      "@submit.prevent='form.handleSubmit(async (vals) => { const out = await create.mutateAsync(vals); pushToast(\"Customer created\"); navigate(`/customers/${out.id}`); })($event)'",
    );
    expect(newPage).toContain('v-model="form.values.name"');
    expect(newPage).toContain(`:error-messages='form.errors["name"]'`);
    expect(newPage).toContain(':loading="create.isPending"');
    // No RHF identifiers may leak into the Vue project.
    expect(newPage).not.toContain("useForm(");
    expect(newPage).not.toContain("register(");
  });

  it("the form runtime emits at src/lib/form.ts with the zod-parse submit shape", async () => {
    const files = await vueFiles();
    const form = files.get("src/lib/form.ts")!;
    expect(form).toContain("export function useLoomForm");
    expect(form).toContain("schema.safeParse(values)");
    expect(form).toContain("issue.path.join(");
    expect(form).toContain("__global");
  });

  it("no JSX artifacts leak into any emitted .vue file", async () => {
    const files = await vueFiles();
    for (const [path, content] of files) {
      if (!path.endsWith(".vue")) continue;
      // JSX expression-comments and JSX attr-binding braces are the
      // tell-tale signs of a template or seam that missed the Vue
      // translation (the plan's Handlebars/Vue collision risk).
      expect(content, `${path} carries a JSX comment`).not.toContain("{/*");
      expect(content, `${path} carries a JSX attr binding`).not.toMatch(/ [a-zA-Z-]+=\{[^{]/);
      // Unrendered Handlebars artifacts (the pack-authoring lint).
      expect(content, `${path} carries an unrendered Handlebars tag`).not.toMatch(/\{\{[#/^]/);
    }
  });
});
