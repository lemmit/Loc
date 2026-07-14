// Vue `DestroyForm { of: <Agg> }` — the confirmation-only named-leaf form for
// the aggregate's canonical destroy (loom-forms.md). Vue forks the shared
// renderer: the `window.confirm(...)` handler can't live in a `@click` template
// expression (Vue's SFC compiler exposes neither `window` nor a bare route
// `id`), so it's HOISTED into `<script setup>` and the button references it by
// name. Regression guard for the showcase Console `kitchen` page, which put a
// DestroyForm on a route WITHOUT an `:id` segment — the route id must still be
// declared (matching React's unconditional `useParams<{id:string}>()`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const sys = (route: string): string => `
  system S {
    subdomain M { context C {
      aggregate Order with crudish { customer: string  derived display: string = this.customer }
      repository Orders for Order { }
    } }
    api A from M
    ui WebApp {
      page OrderAdmin {
        route: "${route}"
        body: Stack { DestroyForm { of: Order } }
      }
    }
    storage pg { type: postgres }
    resource s { for: C, kind: state, use: pg }
    deployable api { platform: node, contexts: [C], dataSources: [s], serves: A, port: 3000 }
    deployable web { platform: vue, targets: api, ui: WebApp, port: 3001 }
  }
`;

describe("Vue DestroyForm — hoisted confirm handler", () => {
  it("hoists the window.confirm handler into <script setup> and references it from @click", async () => {
    const files = await generateSystemFiles(sys("/orders/:id/admin"));
    const page = files.get("web/src/pages/order_admin.vue")!;
    expect(page).toBeDefined();
    // Mutation handle + hoisted handler both live in the script block.
    expect(page).toContain("const deleteOrder = reactive(useDeleteOrder());");
    expect(page).toContain(
      'const onDeleteOrder = () => { if (window.confirm("Delete this order?")) void deleteOrder.mutateAsync(id ?? "").then(() => { navigate("/orders"); }); };',
    );
    // The button references the hoisted handler — NOT an inline `window.confirm`
    // arrow (Vue templates can't reference `window`).
    expect(page).toContain(`@click='onDeleteOrder'`);
    expect(page).not.toMatch(/@click='\(\) => \{ if \(window\.confirm/);
    expect(page).toContain(`:loading='deleteOrder.isPending'`);
    expect(page).toContain('data-testid="orders-destroy"');
  });

  it("declares `const id` even when the route has no `:id` segment (kitchen regression)", async () => {
    // The showcase Console `kitchen` page places a DestroyForm on a plain route.
    // Vue used to gate the route-id declaration on an `:id` segment, so `id` was
    // undeclared and vue-tsc failed; it now binds unconditionally like React.
    const page = (await generateSystemFiles(sys("/kitchen"))).get("web/src/pages/order_admin.vue")!;
    expect(page).toContain("const id = route.params.id as string;");
    expect(page).toContain("const onDeleteOrder = ");
  });
});
