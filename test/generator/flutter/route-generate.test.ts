import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Parameterised routes on Flutter (ledger F2-FFE-3).
//
// `MaterialApp.routes` is an EXACT-string map with no pattern matching, but
// `main.dart` registered the ROUTE TEMPLATE verbatim (`'/things/:id'`) while
// `dartRoute` pushes the interpolated path (`'/things/' + row.id`).  With no
// `onGenerateRoute` anywhere, every detail-page link on flutter was dead
// (`Navigator.onGenerateRoute was null, but the route named "/things/<uuid>"
// was referenced`) — including in the shipped `sales-system-flutter.ddd`.  The
// detail shell already read the id from `settings.arguments`, so the two halves
// disagreed about how the id travels; `onGenerateRoute` is what makes them
// agree, and it is also what makes a Flutter-web deep link resolve.
// ---------------------------------------------------------------------------

const SRC = `
system Fl {
  subdomain S { context C {
    aggregate Thing { name: string }
    repository Things for Thing { }
  } }
  ui App {
    framework: flutter
    page ThingList { route: "/things" body: Stack {
      QueryView { of: Thing.all, data: rows => Table {
        Column { "Id", r => IdLink { r.id, of: Thing } }, rows: rows
      } }
    } }
    page ThingNew { route: "/things/new" body: Stack { CreateForm { of: Thing } } }
    page ThingDetail { route: "/things/:id" body: Stack {
      QueryView { of: Thing.byId(id), single: true, data: t => Text { t.name } }
    } }
  }
  storage db { type: postgres }
  resource st { for: C, kind: state, use: db }
  deployable api { platform: node contexts: [C] dataSources: [st] port: 3000 }
  deployable web { platform: flutter targets: api ui: App port: 3001 }
}
`;

describe("flutter parameterised routes", () => {
  it("resolves ':param' routes through onGenerateRoute, not a verbatim routes: key", async () => {
    const files = await generateSystemFiles(SRC);
    const main = [...files.entries()].find(([k]) => k.endsWith("lib/main.dart"))![1];

    // The template is NEVER a `routes:` key — that entry could not match any
    // pushed path.
    expect(main).not.toContain("'/things/:id': (context) => const ThingDetailPage()");
    // Paramless pages keep the exact-match map (and `routes:` is consulted
    // FIRST, so `/things/new` still beats the `/things/:id` pattern).
    expect(main).toContain("'/things': (context) => const ThingListPage(),");
    expect(main).toContain("'/things/new': (context) => const ThingNewPage(),");

    // The pattern arm, and the captured segment travelling as `arguments`.
    expect(main).toContain("onGenerateRoute: _generateRoute,");
    expect(main).toContain("final segments = Uri.parse(settings.name ?? '/').pathSegments;");
    expect(main).toContain(
      "if (segments.length == 2 && segments[0] == 'things') {\n" +
        "    return _routeTo(settings, const ThingDetailPage(), <String, String>{'id': segments[1]});",
    );
    expect(main).toContain("settings: RouteSettings(name: settings.name, arguments: args),");

    // The other half of the contract: the link pushes the INTERPOLATED path…
    const list = [...files.entries()].find(([k]) => k.endsWith("pages/thing_list_page.dart"))![1];
    expect(list).toContain("pushNamed('/things/' + row.id.toString())");
    // …and the detail shell reads the id back out of the arguments map.
    const detail = [...files.entries()].find(([k]) =>
      k.endsWith("pages/thing_detail_page.dart"),
    )![1];
    expect(detail).toContain("routeArgs['id']");
  });

  it("emits no onGenerateRoute for a ui with no parameterised route", async () => {
    const files = await generateSystemFiles(
      SRC.slice(0, SRC.indexOf("    page ThingDetail")) +
        SRC.slice(SRC.indexOf("  }\n  storage db")),
    );
    const main = [...files.entries()].find(([k]) => k.endsWith("lib/main.dart"))![1];
    expect(main).not.toContain("onGenerateRoute");
    expect(main).not.toContain("_routeTo");
  });
});
