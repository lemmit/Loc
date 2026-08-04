// `DestroyForm { of: <Agg> }` — the confirmation-only named-leaf form for
// the aggregate's CANONICAL destroy (loom-forms.md).  Renders a destructive
// button that window.confirm()s, dispatches `useDelete<Agg>` with the route
// id, and navigates to the aggregate's list route on success (overridable
// via `then: navigate(<Page>)`).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const sys = (body: string, aggExtras = ""): string => `
  system S {
    subdomain M { context C {
      aggregate Order with crudish { customer: string  derived display: string = this.customer ${aggExtras} }
      repository Orders for Order { }
    } }
    api A from M
    ui WebApp {
      page OrderAdmin {
        route: "/orders/:id/admin"
        body: Stack { ${body} }
      }
    }
    storage pg { type: postgres }
    resource s { for: C, kind: state, use: pg }
    deployable api { platform: node, contexts: [C], dataSources: [s], serves: A, port: 3000 }
    deployable web { platform: static
      targets: api
      ui: WebApp
      port: 3001 }
  }
`;

describe("DestroyForm — canonical destroy confirmation", () => {
  it("hoists useDelete<Agg>, confirms, deletes the route id, navigates to the list", async () => {
    const files = await generateSystemFiles(sys(`DestroyForm { of: Order }`));
    const page = files.get("web/src/pages/order_admin.tsx")!;
    expect(page).toContain('import { useDeleteOrder } from "../api/order";');
    // DestroyForm reads the route id, so the shell imports + types useParams.
    expect(page).toContain('import { useParams, useNavigate } from "react-router";');
    expect(page).toContain("const { id } = useParams<{ id: string }>();");
    expect(page).toContain("const deleteOrder = useDeleteOrder();");
    // This page authors NO strings of its own, so the ui is not i18n-enabled —
    // and a FORM primitive must not flip it on (`FORM_CHROME`).  The prompt and
    // label therefore render as plain literals, byte-identical to pre-i18n.
    expect(page).toContain(
      'if (window.confirm("Delete this order?")) ' +
        'void deleteOrder.mutateAsync(id ?? "").then(() => { navigate("/orders"); });',
    );
    expect(page).toContain(">Delete Order</Button>");
    expect(page).toContain('data-testid="orders-destroy"');
    expect(page).toContain("loading={deleteOrder.isPending}");
  });

  it("…and DOES translate once the ui has authored strings", async () => {
    // The other half of the FORM_CHROME rule: form chrome must not FLIP i18n on,
    // but it must ride the catalog once the ui is enabled by an authored string.
    // Otherwise the destroy button and its prompt would be the one English
    // island left in a fully translated app — which is how they shipped before
    // `chrome.deleteEntity`/`deleteConfirm` existed.
    const files = await generateSystemFiles(
      sys(`Stack { Heading { "Danger zone" }, DestroyForm { of: Order } }`),
    );
    const page = files.get("web/src/pages/order_admin.tsx")!;
    expect(page).toContain(
      't("chrome.deleteConfirm", "Delete this {entity}?", { entity: "order" })',
    );
    expect(page).toContain('t("chrome.deleteEntity", "Delete {entity}", { entity: "Order" })');
  });

  it("renders a visible placeholder for an aggregate without a canonical destroy", async () => {
    const files = await generateSystemFiles(`
      system S {
        subdomain M { context C {
          aggregate Note { text: string }
          repository Notes for Note { }
        } }
        ui WebApp {
          page NoteAdmin {
            route: "/notes/:id/admin"
            body: Stack { DestroyForm { of: Note } }
          }
        }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static
          targets: api
          ui: WebApp
          port: 3001 }
      }
    `);
    const page = files.get("web/src/pages/note_admin.tsx")!;
    expect(page).toContain("DestroyForm(of: Note): no canonical destroy");
  });
});
