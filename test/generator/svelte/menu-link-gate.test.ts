// Menu-link hiding on Svelte (D-AUTH-OIDC, UI gate — nav side).  When an
// `auth: ui` svelte frontend has a `menu { link <Page> }` targeting a page with
// a `requires` gate, the app-shell `{#if}`-hides that link at runtime when the
// gate fails — so a forbidden page's link doesn't dangle to its `<Forbidden/>`
// body guard.  The session user is bound only when a link is actually gated.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (opts: { authUi: boolean; menu: boolean }) => `
system Helpdesk {
  user { id: string role: string }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish { subject: string }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from Support
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp${opts.menu ? "" : " with scaffold(subdomains: [Support])"} {
    page Secret { route: "/secret" requires currentUser.role == "agent" body: Heading { "secret" } }
    page Public { route: "/public" body: Heading { "public" } }
    ${opts.menu ? 'menu { section "Main" { link Secret link Public } }' : ""}
  }
  deployable web { platform: svelte targets: api ui: WebApp port: 3001${opts.authUi ? " auth: ui" : ""} }
}
`;

function find(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no file ending ${suffix}`);
}

describe("svelte menu-link gate", () => {
  it("{#if}-wraps a gated link, binds the session user, leaves ungated links", async () => {
    const layout = find(
      await generateSystemFiles(SYS({ authUi: true, menu: true })),
      "(app)/+layout.svelte",
    );
    expect(layout).toContain('import { useSession } from "$lib/auth/AuthGate.svelte";');
    expect(layout).toContain("const currentUser = useSession().user as Record<string, any>;");
    // Secret (gated) is wrapped; Public (ungated) is not.
    expect(layout).toContain('{#if (currentUser.role === "agent")}');
    expect(layout).toContain('href="/secret"');
    expect(layout).toContain('href="/public"');
    expect(layout.match(/\{#if \(/g)?.length ?? 0).toBe(1);
  });

  it("gates the same link when the sidebar is the MERGED default (no menu block)", async () => {
    // With no `ui.menu` block the shell's scaffold grouping is merged with the
    // ui's own pages (M-FT.6), so `Secret` — a hand-written page with a
    // `requires` gate and no `menu { … }` of its own — finally has a sidebar
    // link.  It must be gated exactly as the menu-declared one above: before
    // the merge it had no link at all, which is why this case asserted that
    // nothing was gated.
    const layout = find(
      await generateSystemFiles(SYS({ authUi: true, menu: false })),
      "(app)/+layout.svelte",
    );
    expect(layout).toContain('href="/secret"');
    expect(layout).toContain('{#if (currentUser.role === "agent")}');
    // …and only that link: the scaffolded links and Public are ungated.
    expect(layout.match(/\{#if \(/g)?.length ?? 0).toBe(1);
  });

  it("rejects a gated link without auth: ui (the silent drop is closed)", async () => {
    // This used to assert the shell emitted the link UNGATED — the page's
    // `requires currentUser…` silently unenforced.  Phase ⑦ now refuses the
    // model instead (`requires` joined the currentUser-read placements).
    await expect(generateSystemFiles(SYS({ authUi: false, menu: true }))).rejects.toThrow(
      "loom.current-user-needs-auth-ui",
    );
  });
});

// ---------------------------------------------------------------------------
// M-T3.15-C3 — the DEFAULT sidebar (no explicit `menu { … }`) must gate its
// entries too.  The default entries were assumed to be scaffold pages with no
// `requires`; `scaffold/_pages.ts` now CLONES the aggregate's
// `find all … requires` gate onto the scaffolded List page — the gate that
// guards the very read that page makes — so the ungated sidebar advertised a
// route the backend answers with 403.  Angular's default branch was already
// the reference implementation.
// ---------------------------------------------------------------------------

const DEFAULT_NAV_SYS = (authUi: boolean, gated: boolean) => `
system Helpdesk {
  user { id: string role: string }
  auth { provider: keycloak  oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Support {
    context Tickets {
      aggregate Ticket with crudish { subject: string }
      repository Tickets for Ticket { ${gated ? 'find all(): Ticket[] requires currentUser.role == "agent"' : ""} }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from Support
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp with scaffold(subdomains: [Support]) { api Support: SupportApi }
  deployable web { platform: svelte targets: api ui: WebApp { Support: api } port: 3001${authUi ? " auth: ui" : ""} }
}
`;

describe("Svelte default sidebar honours the list page's requires gate", () => {
  it("wraps the default aggregate nav entry in the gate when auth: ui", async () => {
    const files = await generateSystemFiles(DEFAULT_NAV_SYS(true, true));
    const shell = find(files, "web/src/routes/(app)/+layout.svelte");
    expect(shell).toContain('currentUser.role === "agent"');
    expect(shell).toContain('data-testid="nav-tickets"');
    expect(shell).toContain('{#if (currentUser.role === "agent")}');
  });

  it("an ungated aggregate leaves the entry (and the session binding) alone", async () => {
    const files = await generateSystemFiles(DEFAULT_NAV_SYS(true, false));
    const shell = find(files, "web/src/routes/(app)/+layout.svelte");
    expect(shell).toContain('data-testid="nav-tickets"');
    expect(shell).not.toContain("currentUser");
  });

  // The `auth: ui`-less counterpart is unreachable by construction: a page
  // whose `requires` reads `currentUser` on a deployable that binds no session
  // is refused at phase ⑦ by `loom.current-user-needs-auth-ui`.  So the gate
  // can never dangle — the model that would produce it does not compile.
});
