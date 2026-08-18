// Flutter `auth: ui` (D-AUTH-OIDC) — the frontend session guard.
//
// `AUTH_UI_FRAMEWORKS` used to exclude flutter and `flutter/index.ts` hard-coded
// `false // authUi`, so a Flutter-hosted ui could not opt into the guard at all
// (`loom.auth-ui-unsupported-framework`).  The port mirrors what Feliz ships:
// a session probe, an app-wide gate, a per-page `requires` guard, and
// action-button gating on a currentUser-only op `requires`.
//
// Two Flutter-specific decisions the assertions pin, because both are the kind
// of thing a later refactor would silently undo:
//
//   * the gate rides `MaterialApp.builder`, NOT a wrapper around `MaterialApp` —
//     its Material widgets need the app's Theme/Directionality ancestors, and an
//     outer wrapper would unmount the `MaterialApp` while the probe is in
//     flight, which the emitted boot smoke reads as an app that never mounted;
//   * the page shell binds a NON-NULL `currentUser`, because `AuthGate` gates
//     every route — that is what lets a claim read sit in an ordinary expression
//     with no null hop.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SYS = (auth: string) => `
system Helpdesk {
  user { id: string  role: string  permissions: string[] }
  auth { provider: keycloak oidc { issuer: env("OIDC_ISSUER") clientId: env("OIDC_CLIENT_ID") } }
  subdomain Support {
    context Tickets {
      aggregate Ticket {
        subject: string
        open: bool
        operation close() requires currentUser.role == "admin" { open := false }
        derived display: string = subject
      }
      repository Tickets for Ticket { }
    }
  }
  storage primary { type: postgres }
  resource st { for: Tickets, kind: state, use: primary }
  api SupportApi from Support
  deployable api { platform: node contexts: [Tickets] serves: SupportApi dataSources: [st] port: 8080 auth: required }
  ui WebApp {
    api Support: SupportApi
    page Home {
      route: "/"
      body: Stack { Heading { "Helpdesk", level: 1 }, Text { currentUser.id } }
    }
    page Admin {
      route: "/admin"
      requires currentUser.role == "admin"
      body: Stack { Heading { "Admin", level: 1 } }
    }
    page TicketDetail {
      route: "/tickets/:id"
      body: QueryView {
        of: Support.Ticket.byId(id),
        loading: Text { "…" }, error: Text { "err" }, empty: Text { "none" },
        data: t => Stack { Text { t.subject }, Action { t.close } }
      }
    }
  }
  deployable web { platform: flutter targets: api ui: WebApp { Support: api } port: 3001 ${auth} }
}`;

const gated = () => generateSystemFiles(SYS("auth: ui"));

describe("flutter auth: ui — the session module", () => {
  it("decodes the declared claims into a typed CurrentUser", async () => {
    const dart = (await gated()).get("web/lib/auth.dart")!;
    expect(dart).toContain("class CurrentUser {");
    expect(dart).toContain("final String role;");
    expect(dart).toContain("final List<String> permissions;");
    expect(dart).toContain("factory CurrentUser.fromJson(Map<String, dynamic> json) =>");
  });

  it("probes /auth/me and answers `null` rather than throwing", async () => {
    const dart = (await gated()).get("web/lib/auth.dart")!;
    expect(dart).toContain("final sessionProvider = FutureProvider<CurrentUser?>((ref) async {");
    expect(dart).toContain("final res = await http.get(apiUri('/auth/me'));");
    expect(dart).toContain("if (res.statusCode != 200) return null;");
    expect(dart).toContain("} catch (_) {");
  });

  it("redirects to the backend's own sign-in / sign-out handshake", async () => {
    const out = await gated();
    const dart = out.get("web/lib/auth.dart")!;
    expect(dart).toContain("Future<void> signIn() => _authRedirect('/auth/login');");
    expect(dart).toContain("Future<void> signOut() => _authRedirect('/auth/logout');");
    // `_self` = a same-tab navigation on the web (what the JS frontends do with
    // `window.location.href`); the system browser on a native surface.
    expect(dart).toContain("await launchUrl(apiUri(path), webOnlyWindowName: '_self');");
    // The one pub package the guard pulls, and only under `auth: ui`.
    expect(out.get("web/pubspec.yaml")!).toContain("url_launcher: ^6.3.1");
  });

  it("gates the app through MaterialApp.builder, not a wrapper around it", async () => {
    const main = (await gated()).get("web/lib/main.dart")!;
    expect(main).toContain("import 'auth.dart';");
    expect(main).toContain("builder: (context, child) =>");
    expect(main).toContain("AuthGate(child: child ?? const SizedBox.shrink()),");
    // The MaterialApp itself is never displaced — the boot smoke finds it on
    // the first frame even while the probe is in flight.
    expect(main).toContain("return ProviderScope(child: MaterialApp(");
  });
});

describe("flutter auth: ui — the page and action guards", () => {
  it("renders ForbiddenView when a page `requires` fails", async () => {
    const dart = (await gated()).get("web/lib/pages/admin_page.dart")!;
    expect(dart).toContain("import '../auth.dart';");
    expect(dart).toContain("class AdminPage extends ConsumerWidget {");
    // Non-null: `AuthGate` guarantees a session before any route builds.
    expect(dart).toContain("final currentUser = ref.watch(sessionProvider).value!;");
    expect(dart).toContain("child: (currentUser.role == 'admin')");
    expect(dart).toContain(": const ForbiddenView(),");
  });

  it("binds the claims for a plain `currentUser.<claim>` body read too", async () => {
    const dart = (await gated()).get("web/lib/pages/home_page.dart")!;
    expect(dart).toContain("final currentUser = ref.watch(sessionProvider).value!;");
    expect(dart).toContain("currentUser.id");
    // No `requires` on this page → no ForbiddenView branch.
    expect(dart).not.toContain("ForbiddenView");
  });

  it("hides an Action button whose op carries a currentUser-only `requires`", async () => {
    const dart = (await gated()).get("web/lib/pages/ticket_detail_page.dart")!;
    expect(dart).toContain("((currentUser.role == 'admin')) ? ElevatedButton(");
    expect(dart).toContain(": const SizedBox.shrink()");
  });
});

describe("flutter without auth: ui — byte-identical to before the port", () => {
  it("emits no auth module, no dependency, no session binding", async () => {
    const out = await generateSystemFiles(SYS(""));
    expect(out.has("web/lib/auth.dart")).toBe(false);
    expect(out.get("web/pubspec.yaml")!).not.toContain("url_launcher");
    const main = out.get("web/lib/main.dart")!;
    expect(main).not.toContain("AuthGate");
    expect(main).not.toContain("builder: (context, child)");
    // A `currentUser` read with no guard is refused by
    // `loom.current-user-needs-auth-ui`, so this system's un-gated variant only
    // proves the ABSENCE side; the Action button stays ungated (the backend 403
    // still enforces the op's `requires` — defence in depth).
    const detail = out.get("web/lib/pages/ticket_detail_page.dart")!;
    expect(detail).not.toContain("currentUser");
    expect(detail).toContain("ElevatedButton(onPressed: () async {");
  });
});
