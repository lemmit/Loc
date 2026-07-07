// Phoenix (LiveView) sidebar menu-link hiding — the Phoenix sibling of the
// React/Svelte/Vue/Angular menu-link gating.  When the app has auth
// (`auth: required` → `LiveAuth.on_mount` assigns `@current_user`) AND a
// page carries a currentUser-only `requires` gate, the sidebar nav link to
// that page is wrapped in a HEEx `<%= if (<gate>) do %> … <% end %>` against
// `@current_user`, hiding it server-side when the gate fails.
//
//   - An ungated page's link is emitted unconditionally (no `if` wrapper).
//   - A no-auth app emits NO gating (no `@current_user` exists) — the sidebar
//     is byte-identical to before, and the layout passes no `current_user`.
//   - A non-currentUser predicate (one touching `this`/params) leaves the
//     link ungated (the sidebar has no record context).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

/** Auth (or no-auth) Phoenix LiveView app with two pages — one gated by a
 *  currentUser-only `requires`, one ungated — plus an explicit menu so both
 *  are sidebar links. */
function system(opts: { auth: boolean; gate?: string }): string {
  const authBits = opts.auth ? `  user { id: string  role: string }\n` : "";
  const deployAuth = opts.auth ? "    auth: required\n" : "";
  const gateClause = opts.gate ?? 'requires currentUser.role == "agent"';
  return `
system Acme {
${authBits}  subdomain Sales {
    context Tickets {
      aggregate Ticket { subject: string  open: bool }
      repository Tickets for Ticket { }
    }
  }
  ui Web {
    page Admin { route: "/admin" ${gateClause} body: Stack { Heading("Admin", level: 1) } }
    page Public { route: "/public" body: Stack { Heading("Public", level: 1) } }
    menu {
      section "Main" {
        link Admin
        link Public
      }
    }
  }
  api SalesApi from Sales
  storage primary { type: postgres }
  resource salesState { for: Tickets, kind: state, use: primary }
  deployable app {
    platform: elixir
    contexts: [Tickets]
    dataSources: [salesState]
    serves: SalesApi
    ui: Web
    port: 4000
${deployAuth}  }
}
`;
}

async function sidebar(opts: { auth: boolean; gate?: string }): Promise<string> {
  const files = await generateSystemFiles(system(opts));
  const src = files.get("app/lib/app_web/components/sidebar.ex");
  expect(src, "sidebar.ex not emitted").toBeDefined();
  return src!;
}

describe("phoenix sidebar — menu-link gate", () => {
  it("wraps a gated page's link in `<%= if (@current_user.…) do %>` when auth is on", async () => {
    const src = await sidebar({ auth: true });
    // The Admin link is gated against @current_user (template scope).
    expect(src).toContain('<%= if (@current_user.role == "agent") do %>');
    expect(src).toContain("<% end %>");
    // The gate wraps the Admin link, not the Public link.
    expect(src).toContain('navigate={~p"/admin"}');
    expect(src).toContain('navigate={~p"/public"}');
    // The component declares the current_user attr.
    expect(src).toContain("attr :current_user, :map, default: nil");
  });

  it("leaves an ungated page's link unwrapped", async () => {
    const src = await sidebar({ auth: true });
    // Only ONE `if` wrapper (Admin); Public is not gated.
    const ifCount = src.split("<%= if (").length - 1;
    expect(ifCount).toBe(1);
    // The Public link's <.link> is not immediately preceded by an `if`.
    const publicIdx = src.indexOf('navigate={~p"/public"}');
    const before = src.slice(0, publicIdx);
    expect(before.lastIndexOf("<%= if (")).toBeLessThan(before.lastIndexOf("<% end %>"));
  });

  it("emits NO gating when the app has no auth (byte-identical)", async () => {
    const src = await sidebar({ auth: false });
    expect(src).not.toContain("<%= if (");
    expect(src).not.toContain("attr :current_user");
    // Both links still render, just ungated.
    expect(src).toContain('navigate={~p"/admin"}');
    expect(src).toContain('navigate={~p"/public"}');
  });

  it("leaves a non-currentUser predicate ungated (no record context in the sidebar)", async () => {
    // `open` is not a currentUser claim — the sidebar can't evaluate it, so
    // the link stays ungated even though auth is on.
    const src = await sidebar({ auth: true, gate: "requires open == true" });
    expect(src).not.toContain("<%= if (");
  });

  it("forwards @current_user from the app layout to the sidebar when auth is on", async () => {
    const files = await generateSystemFiles(system({ auth: true }));
    const layout = files.get("app/lib/app_web/components/layouts/app.html.heex");
    expect(layout, "app layout not emitted").toBeDefined();
    expect(layout!).toContain("current_user={@current_user}");
  });

  it("the no-auth app layout passes no current_user (byte-identical)", async () => {
    const files = await generateSystemFiles(system({ auth: false }));
    const layout = files.get("app/lib/app_web/components/layouts/app.html.heex");
    expect(layout, "app layout not emitted").toBeDefined();
    expect(layout!).not.toContain("current_user=");
  });
});
