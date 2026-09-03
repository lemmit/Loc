import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `parseUrl` arm ORDER (ledger F2-FFE-5).
//
// F# takes the first matching rule, and `routePattern` turns a `:param` segment
// into a binder that matches ANY segment — so a literal route declared after a
// sibling parameterised route of the same length was a dead rule.  `/things/new`
// declared after `/things/:id` routed the create form to the DETAIL view with
// `id = "new"`; F# reports it only as warning FS0026 and the generated
// `App.fsproj` sets no `TreatWarningsAsErrors`, so the feliz build gate stayed
// green.  The scaffold happens to declare New before Detail, which is why no
// shipped example hit it.
// ---------------------------------------------------------------------------

const sys = `
  system S {
    subdomain M { context Sales {
      aggregate Thing { name: string }
      repository Things for Thing { }
    } }
    ui WebApp {
      page ThingList { route: "/things" body: Stack { Text { "list" } } }
      page ThingDetail { route: "/things/:id" body: Stack { Text { "detail" } } }
      page ThingNew { route: "/things/new" body: Stack { CreateForm { of: Thing } } }
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node contexts: [Sales] dataSources: [salesState] port: 3000 }
    deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
  }
`;

describe("feliz parseUrl arm order", () => {
  it("puts a literal route ahead of a same-length parameterised sibling declared before it", async () => {
    const files = await generateSystemFiles(sys);
    const fs = [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
    const parse = fs.slice(fs.indexOf("let parseUrl"), fs.indexOf("type Model"));
    const literal = parse.indexOf('| [ "things"; "new" ] -> ThingNew');
    const param = parse.indexOf('| [ "things"; id ] -> ThingDetail id');
    expect(literal).toBeGreaterThanOrEqual(0);
    expect(param).toBeGreaterThanOrEqual(0);
    expect(literal).toBeLessThan(param);
    // The one-segment list arm keeps its declaration position — sorting is
    // WITHIN a segment-count group, so an already-correct ui is untouched.
    expect(parse.indexOf('| [ "things" ] -> ThingList')).toBeLessThan(literal);
  });
});
