import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

// ---------------------------------------------------------------------------
// Svelte generator — fast string-level shape assertions over the
// emitted SvelteKit project (the compile gates live in the opt-in
// LOOM_SVELTE_BUILD suite).  Mirrors the react generator-react suite's
// granularity: one assertion block per emission concern.
// ---------------------------------------------------------------------------

const SRC = `
system Shop {
    subdomain Sales {
        context Orders {
            enum OrderStatus { Draft, Confirmed, Cancelled }
            aggregate Customer with crudish {
                name: string
                email: string
                invariant name.length > 0
                derived display: string = name
            }
            aggregate Order {
                customerId: Customer id
                status: OrderStatus
                placedAt: datetime
                operation confirm() {
                    precondition status == OrderStatus.Draft
                    status := OrderStatus.Confirmed
                }
                derived display: string = "Order"
            }
            repository Customers for Customer { }
            repository Orders for Order { }
            workflow placeOrder {
                create(customerId: Customer id) {
                    let order = Order.create({
                        customerId: customerId,
                        status: Draft,
                        placedAt: now()
                    })
                }
            }
            view ActiveOrders = Order where status == Confirmed
        }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordersState { for: Orders, kind: state, use: primarySql }
    ui WebApp with scaffold(subdomains: [Sales]) {
        api Sales: SalesApi
        page Welcome {
            route: "/welcome"
            title: "Welcome"
            state { count: int = 0 }
            body: Stack {
                Heading { "Shop", level: 1 },
                Button { "Bump", onClick: e => { count := count + 1 }, testid: "bump" }
            }
        }
    }
    deployable api {
        platform: node
        contexts: [Orders]
        dataSources: [ordersState]
        serves: SalesApi
        port: 8080
    }
    deployable web {
        platform: svelte
        targets: api
        ui: WebApp { Sales: api }
        port: 3002
    }
}
`;

async function files(): Promise<Map<string, string>> {
  return generateSystemFiles(SRC);
}

describe("svelte generator — project shape", () => {
  it("emits the SvelteKit shell (config, app.html, layouts, theme)", async () => {
    const out = await files();
    expect(out.get("web/svelte.config.js")).toContain("adapter-static");
    expect(out.get("web/svelte.config.js")).toContain('fallback: "index.html"');
    expect(out.get("web/vite.config.ts")).toContain("sveltekit()");
    expect(out.get("web/src/app.html")).toContain("%sveltekit.body%");
    expect(out.get("web/src/routes/+layout.ts")).toContain("export const ssr = false;");
    expect(out.get("web/src/routes/+layout.svelte")).toContain("QueryClientProvider");
    expect(out.get("web/src/routes/(app)/+layout.svelte")).toContain("{@render children()}");
    expect(out.get("web/src/theme.css")).toContain("--loom-primary");
    expect(out.get("web/package.json")).toContain('"@tanstack/svelte-query"');
    expect(out.get("web/Dockerfile")).toContain("vite preview");
  });

  it("emits per-aggregate api modules with svelte-query factories + shared zod schemas", async () => {
    const out = await files();
    const customer = out.get("web/src/lib/api/customer.ts") ?? "";
    expect(customer).toContain('from "@tanstack/svelte-query"');
    expect(customer).toContain("export const CreateCustomerRequest = z.object({");
    // Paged-by-default findAll (M-T2.6): the `all` hook takes a query getter and
    // parses the `<Agg>Paged` envelope (a block body, not the `() => ({` form).
    expect(customer).toContain(
      "export function useAllCustomers(query: () => AllQueryInput = () => ({})) {",
    );
    expect(customer).toContain("return CustomerPaged.parse(r);");
    expect(customer).toContain("export function useCustomerById(id: () => string | undefined) {");
    expect(customer).toContain("export function useCreateCustomer() {");
    // The schema half must match the react module byte-for-byte (the
    // wire contract is framework-independent).
    const order = out.get("web/src/lib/api/order.ts") ?? "";
    expect(order).toContain("export function useConfirmOrder(id: () => string) {");
  });

  it("emits workflows + views api modules", async () => {
    const out = await files();
    expect(out.get("web/src/lib/api/workflows.ts")).toContain(
      "export function usePlaceOrderWorkflow() {",
    );
    expect(out.get("web/src/lib/api/views.ts")).toContain(
      "export function useActiveOrdersView() {",
    );
  });

  it("maps scaffold pages onto SvelteKit file routes in the (app) group", async () => {
    const out = await files();
    expect(out.has("web/src/routes/(app)/+page.svelte")).toBe(true);
    expect(out.has("web/src/routes/(app)/customers/+page.svelte")).toBe(true);
    expect(out.has("web/src/routes/(app)/customers/new/+page.svelte")).toBe(true);
    expect(out.has("web/src/routes/(app)/customers/[id]/+page.svelte")).toBe(true);
    expect(out.has("web/src/routes/(app)/workflows/place_order/+page.svelte")).toBe(true);
    expect(out.has("web/src/routes/(app)/views/active_orders/+page.svelte")).toBe(true);
  });

  it("walks page bodies through the shared walker with the svelte target", async () => {
    const out = await files();
    const list = out.get("web/src/routes/(app)/customers/+page.svelte") ?? "";
    // svelte-query handle hoisted in <script>, consumed via {#if}/{#each}.
    // Server-paged (M-T2.6): the hook takes the page window + sort controls.
    expect(list).toContain(
      "const customerAll = useAllCustomers(() => ({ page: pageNum, pageSize: 10, sort: sortKey, dir: sortDir }));",
    );
    expect(list).toContain("{#if customerAll.isLoading}");
    // Since M-T2.6 the scaffold list is server-paged, so rows come straight off
    // the `Paged<T>` envelope's `.items`; the `(… ?? [])` guard still surrounds it.
    expect(list).toContain("{#each (customerAll.data.items ?? []) as row (row.id)}");
    expect(list).toContain('data-testid="customers-list"');
    // Explicit page: runes state + plain-assignment writes + $effect title.
    const welcome = out.get("web/src/routes/(app)/welcome/+page.svelte") ?? "";
    expect(welcome).toContain("let count = $state<number>(0);");
    expect(welcome).toContain("count = (count + 1);");
    expect(welcome).toContain("$effect(() => {");
    expect(welcome).toContain('document.title = "Welcome";');
  });

  it("wires create forms through the runes form helper", async () => {
    const out = await files();
    const newPage = out.get("web/src/routes/(app)/customers/new/+page.svelte") ?? "";
    expect(newPage).toContain("const form = createForm(CreateCustomerRequest,");
    expect(newPage).toContain("const create = useCreateCustomer();");
    expect(newPage).toContain("bind:value={form.values.name }");
    expect(newPage).toContain('form.errors["name"]');
    expect(newPage).toContain("form.submit(async (vals) =>");
    // No react-hook-form leakage (the TSX form runtime).
    expect(newPage).not.toContain("react-hook-form");
    expect(newPage).not.toContain("zodResolver");
  });

  it("renders operation forms as page-scope snippets opened from the modal site", async () => {
    const out = await files();
    const detail = out.get("web/src/routes/(app)/orders/[id]/+page.svelte") ?? "";
    expect(detail).toContain("const confirmForm = createForm(ConfirmOrderRequest,");
    expect(detail).toContain("{@render confirmOpModal(confirmForm)}");
    expect(detail).toContain("{#snippet confirmOpModal(form: LoomForm<ConfirmOrderRequest>)}");
    expect(detail).toContain('data-testid="orders-op-confirm-submit"');
  });

  it("magic route id: a hand-written byId(id) page derives id from page.params", async () => {
    // The bare `id` magic identifier (NOT a declared param) used to render
    // `/* unsupported expr: id */ undefined`, so the byId read never fetched.
    const out = await generateSystemFiles(`
      system S {
        api SalesApi from Sales
        subdomain Sales {
          context Orders {
            aggregate Item { name: string }
            repository Items for Item { find byId(id: string): Item? }
          }
        }
        ui WebApp {
          api Sales: SalesApi
          page ItemDetail {
            route: "/items/:id"
            body: QueryView { of: Sales.Item.byId(id), single: true, data: o => Text { o.name } }
          }
        }
        deployable api { platform: node, contexts: [Orders], port: 3000 }
        deployable web { platform: svelte, targets: api, ui: WebApp, port: 3002 }
      }
    `);
    const detail = out.get("web/src/routes/(app)/items/[id]/+page.svelte") ?? "";
    expect(detail).not.toContain("unsupported expr: id");
    expect(detail).toContain('const id = $derived(page.params.id ?? "");');
    expect(detail).toContain("const itemById = useItemById(() => (id));");
  });

  it("emits the runes form/toast/format lib and no react artifacts", async () => {
    const out = await files();
    expect(out.get("web/src/lib/forms.svelte.ts")).toContain("export function createForm");
    expect(out.get("web/src/lib/toast.svelte.ts")).toContain("export const toast");
    expect(out.get("web/src/lib/format.ts")).toContain("export function formatMoney");
    for (const path of out.keys()) {
      if (!path.startsWith("web/")) continue;
      expect(path).not.toMatch(/\.tsx$/);
    }
    expect(out.has("web/src/App.tsx")).toBe(false);
    expect(out.has("web/index.html")).toBe(false);
  });
});
