// Phoenix (LiveView) operation action-button gating — the Phoenix sibling of
// the React/Svelte/Vue/Angular action-button gating, and the followup that
// completes the Phoenix UI-gate row (page guard → menu link → action button).
//
// An `Action(<instance>.<op>)` button renders as a `<.button phx-click=…>` in
// the LiveView page/component body.  When the host deployable runs
// `auth: required` (so `LiveAuth.on_mount` assigns `@current_user`) AND every
// `requires` predicate on the operation is currentUser-only, the `<.button>`
// is wrapped in a HEEx `<%= if (@current_user.…) do %> … <% end %>`, hiding it
// server-side when the gate fails.  The Ash action still enforces the gate
// regardless — this is the cosmetic UI mirror.
//
//   - An op with no `requires` → ungated button (no `if` wrapper).
//   - No auth → NO gating, byte-identical output.
//   - A non-currentUser predicate (touching `this`/params) → ungated button.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Phoenix LiveView app whose Detail page hosts two action buttons — `confirm`
 *  (carries a `requires`) and `cancel` (none) — rendered inline in a QueryView
 *  `data:` lambda so the buttons live in the page LiveView.  `auth` toggles
 *  `auth: required` on the deployable; `gate` overrides `confirm`'s `requires`. */
function system(opts: { auth: boolean; gate?: string }): string {
  const authBits = opts.auth ? "  user { id: string  role: string }\n" : "";
  const deployAuth = opts.auth ? "    auth: required\n" : "";
  const gateClause = opts.gate ?? 'requires currentUser.role == "manager"';
  return `
system Acme {
${authBits}  subdomain Sales {
    context Sales {
      aggregate Customer {
        name: string
        status: string
        operation confirm() { ${gateClause}  status := "confirmed" }
        operation cancel() { status := "cancelled" }
      }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin {
    api Sales: SalesApi
    page Detail {
      route: "/customers/:id"
      body: QueryView {
        of: Sales.Customer.byId(id),
        single: true,
        loading: Loader {},
        empty: Empty { "Not found" },
        data: c => Toolbar { Action { c.confirm }, Action { c.cancel } }}
    }
  }
  storage primary { type: postgres }
  resource salesState { for: Sales, kind: state, use: primary }
  deployable phoenixApp {
    platform: elixir
    contexts: [Sales]
    dataSources: [salesState]
    serves: SalesApi
    ui: SalesAdmin { Sales: phoenixApp }
    port: 4000
${deployAuth}  }
}
`;
}

/** The Detail page LiveView hosting the two action buttons. */
async function detailLive(opts: { auth: boolean; gate?: string }): Promise<string> {
  const files = await generateSystemFiles(system(opts));
  const src = files.get("phoenix_app/lib/phoenix_app_web/live/detail_live.ex");
  expect(src, "detail_live.ex not emitted").toBeDefined();
  return src!;
}

describe("phoenix operation action-button gate", () => {
  it("wraps a currentUser-gated button in `<%= if (@current_user.…) do %>` when auth is on", async () => {
    const src = await detailLive({ auth: true });
    // confirm() has a currentUser-only `requires` → gated, in template scope.
    expect(src).toContain(
      '<%= if ((@current_user.role == "manager")) do %><.button phx-click="confirm_customer"',
    );
    expect(src).toContain("</.button><% end %>");
    // Exactly ONE gate wrapper (confirm); cancel has no `requires`.
    expect(src.split("<%= if (").length - 1).toBe(1);
    // Both buttons still render; their handlers hoist into the LiveView.
    expect(src).toContain('phx-click="confirm_customer"');
    expect(src).toContain('phx-click="cancel_customer"');
    expect(src).toContain('def handle_event("confirm_customer"');
  });

  it("leaves an ungated operation's button unwrapped (auth on, no requires)", async () => {
    const src = await detailLive({ auth: true });
    // cancel() has no `requires` → its <.button> is not inside an `if`.
    const cancelIdx = src.indexOf('phx-click="cancel_customer"');
    const before = src.slice(0, cancelIdx);
    expect(before.lastIndexOf("<%= if (")).toBeLessThan(before.lastIndexOf("<% end %>"));
  });

  it("emits NO gating when the deployable has no auth (byte-identical)", async () => {
    const src = await detailLive({ auth: false });
    expect(src).not.toContain("<%= if (");
    // Both buttons still render, just ungated.
    expect(src).toContain('phx-click="confirm_customer"');
    expect(src).toContain('phx-click="cancel_customer"');
  });

  it("leaves a non-currentUser predicate ungated (the Ash action still enforces)", async () => {
    // `status` is not a currentUser claim — not template-evaluable, so the
    // button stays ungated even though auth is on.
    const src = await detailLive({ auth: true, gate: 'requires status == "draft"' });
    expect(src).not.toContain("<%= if (");
  });
});
