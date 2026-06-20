// Operation action-button gating on React (D-AUTH-OIDC, the action-level
// mirror of the page `requires` UI gate).  When a frontend has `auth: ui` and a
// page body renders an `Action(<instance>.<op>)` button for an operation whose
// `requires` gate is *currentUser-only*, the button is hidden at runtime when
// the gate fails — `{(currentUser...) ? <Button.../> : null}`.  Gating happens
// iff EVERY `requires` predicate renders cleanly via the currentUser-only gate
// renderer; an op with no `requires`, or any predicate touching `this`/a param,
// leaves the button ungated (the backend 403 still enforces it).  Without
// `auth: ui` the page is byte-identical to before.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

/** A system whose `Sales` context has an `Order` aggregate with two
 *  operations (`confirm` / `cancel`) whose `requires` clauses the caller
 *  picks.  An `OrderConsole` page loads one order via a QueryView and renders
 *  an `Action` button per op directly in the body (the QueryView `data`
 *  lambda binds `o` typed to `Order`).  `authUi` toggles `auth: ui` on the
 *  react deployable; `pageGate` optionally adds a page-level `requires`. */
const SYS = (opts: {
  authUi: boolean;
  confirmRequires: string;
  cancelRequires?: string;
  pageGate?: string;
}) => `
system Helpdesk {
  user { id: string role: string }
  auth {
    provider: keycloak
    oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") }
  }
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation confirm() {
          ${opts.confirmRequires}
        }
        operation cancel() {
          ${opts.cancelRequires ?? ""}
        }
        derived display: string = customerId
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api {
    platform: node
    contexts: [Sales]
    serves: SalesApi
    dataSources: [salesState]
    port: 8080
    auth: required
  }
  ui WebApp with scaffold(aggregates: [Order]) {
    api Sales: SalesApi
    page OrderConsole {
      route: "/console/:id"
      ${opts.pageGate ?? ""}body: QueryView {
        of: Sales.Order.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "Order not found" },
        data: o => Toolbar {
          Action { o.confirm },
          Action { o.cancel }
        }}
    }
  }
  deployable web {
    platform: react
    targets: api
    ui: WebApp { Sales: api }
    port: 3001${opts.authUi ? "\n    auth: ui" : ""}
  }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

const PAGE = "web/src/pages/order_console.tsx";
const BIND = /const currentUser = useSession\(\)\.user as Record<string, any>;/g;

describe("react operation action-button gate", () => {
  it("wraps an Action button in a currentUser-only gate on auth: ui (a)", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: true, confirmRequires: 'requires currentUser.role == "manager"' }),
    );
    const page = find(files, PAGE);
    expect(page).toContain("const currentUser = useSession().user as Record<string, any>;");
    expect(page).toContain('import { useSession } from "../auth/AuthGate";');
    // The button is wrapped in a `(gate) ? <button> : null` conditional child.
    expect(page).toContain('(currentUser.role === "manager")');
    expect(page).toMatch(/\(currentUser\.role === "manager"\)\s*\?/);
    expect(page).toContain("null");
  });

  it("leaves an op WITHOUT requires ungated (b)", async () => {
    // confirm has a currentUser gate; cancel has none.
    const files = await generateSystemFiles(
      SYS({ authUi: true, confirmRequires: 'requires currentUser.role == "manager"' }),
    );
    const page = find(files, PAGE);
    // Exactly one gate appears (cancel's button is not wrapped).
    const gateCount = (page.match(/currentUser\.role === "manager"/g) ?? []).length;
    expect(gateCount).toBe(1);
    // currentUser is bound exactly once even though two buttons render.
    expect((page.match(BIND) ?? []).length).toBe(1);
  });

  it("leaves an op whose requires touches this/a param ungated (c)", async () => {
    // `status` is a `this.<field>` ref — not client-evaluable.
    const files = await generateSystemFiles(
      SYS({ authUi: true, confirmRequires: 'requires status == "open"' }),
    );
    const page = find(files, PAGE);
    // No currentUser binding/import and no wrap — the op gate is not
    // client-evaluable, so the backend 403 alone enforces it.
    expect(page).not.toContain("useSession");
    expect(page).not.toContain("currentUser");
  });

  it("binds currentUser exactly once with BOTH a page requires and a gated button (d)", async () => {
    const files = await generateSystemFiles(
      SYS({
        authUi: true,
        confirmRequires: 'requires currentUser.role == "manager"',
        pageGate: 'requires currentUser.role == "agent"\n      ',
      }),
    );
    const page = find(files, PAGE);
    // The const + import appear exactly once despite both consumers.
    expect((page.match(BIND) ?? []).length).toBe(1);
    expect((page.match(/import \{ useSession \}/g) ?? []).length).toBe(1);
    // The page-level Forbidden guard is still present (requires drives it).
    expect(page).toContain("<h2>Forbidden</h2>");
    expect(page).toContain('if (!(currentUser.role === "agent"))');
    // The button gate is also present.
    expect(page).toContain('(currentUser.role === "manager")');
  });

  it("emits no gate and no binding without auth: ui (e)", async () => {
    const files = await generateSystemFiles(
      SYS({ authUi: false, confirmRequires: 'requires currentUser.role == "manager"' }),
    );
    const page = find(files, PAGE);
    expect(page).not.toContain("useSession");
    expect(page).not.toContain("currentUser");
  });

  it("gates Action buttons hosted in a user component too (component path)", async () => {
    // The canonical Action host is a `component(order: Order)` whose buttons
    // wire `use<Op>Order(order.id)` — the gate binds currentUser in the
    // component file (binding-only: components carry no page `requires`).
    const COMP_SYS = `
system Helpdesk {
  user { id: string role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Sales {
    context Sales {
      aggregate Order with crudish {
        customerId: string
        status: string
        operation confirm() { requires currentUser.role == "manager" }
        operation cancel() { }
        derived display: string = customerId
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable api { platform: node contexts: [Sales] serves: SalesApi dataSources: [salesState] port: 8080 auth: required }
  ui WebApp with scaffold(aggregates: [Order]) {
    api Sales: SalesApi
    component OrderActions(order: Order) {
      body: Toolbar { Action { order.confirm }, Action { order.cancel } }
    }
    page Home { route: "/" body: Heading { "Home", level: 1 } }
  }
  deployable web { platform: react targets: api ui: WebApp { Sales: api } port: 3001 auth: ui }
}
`;
    const files = await generateSystemFiles(COMP_SYS);
    const comp = find(files, "web/src/components/OrderActions.tsx");
    expect(comp).toContain("const currentUser = useSession().user as Record<string, any>;");
    expect(comp).toContain('import { useSession } from "../auth/AuthGate";');
    expect(comp).toContain('(currentUser.role === "manager")');
    // Binding-only — no Forbidden guard in a component.
    expect(comp).not.toContain("Forbidden");
    // One gate (cancel ungated), one binding.
    expect((comp.match(/currentUser\.role === "manager"/g) ?? []).length).toBe(1);
    expect((comp.match(BIND) ?? []).length).toBe(1);
  });
});
