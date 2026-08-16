// Feliz MVU update path — the expression arms `renderFsExpr` was missing.
//
// `fs-expr.ts` is a SECOND expression dispatcher (the view path goes through
// the shared `_walker/walker-core.ts`), and its `default` threw on any kind it
// had no arm for.  Three of those kinds are reachable from perfectly ordinary
// `.ddd`, so `ddd generate system` CRASHED instead of emitting:
//
//   • `id`       — `action pick() { sel := string(id) }` on a routed detail
//                  page.  The view path renders it through the
//                  `felizTarget.renderRouteId` seam; the update path had no arm.
//   • `duration` — `until := now() + days(7)`.
//   • `new`      — part construction; only reachable through `renderFsExpr`
//                  directly today (a page body cannot name an entity part —
//                  `loom.unknown-builder-type` rejects it), but the arm keeps
//                  the two paths on the same record form.
//
// The route `id` is the interesting one: `update`/`init` run OUTSIDE every page
// view fn, so there is no `id` parameter in scope to render to.  The MVU answer
// is to read it back off the parsed route, which is what the `routeId` accessor
// emitted beside `parseUrl` does — so the same `.ddd` expression means the same
// value on both feliz paths.

import { describe, expect, it } from "vitest";
import { renderFsExpr } from "../../../src/generator/feliz/fs-expr.js";
import { generateFelizForContexts } from "../../../src/generator/feliz/index.js";
import type { ExprIR } from "../../../src/ir/types/loom-ir.js";
import { DURATION_UNIT_MS } from "../../../src/util/temporal.js";
import { buildLoomModel } from "../../_helpers/ir.js";

const sys = (pages: string) => `
system P {
  subdomain S { context C {
    aggregate Order { name: string }
    repository Orders for Order { }
  } }
  api A from S
  ui WebApp {
    api C: A
    ${pages}
  }
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: node contexts: [C] dataSources: [st] serves: A port: 3000 }
  deployable web { platform: feliz targets: api ui: WebApp { C: api } port: 3005 }
}`;

/** Generate `src/App.fs` for a feliz-hosted ui with these pages. */
async function app(pages: string): Promise<string> {
  const model = await buildLoomModel(sys(pages));
  const s = model.systems[0]!;
  const web = s.deployables.find((d) => d.name === "web")!;
  return generateFelizForContexts(s.subdomains[0]!.contexts, s, web).get("src/App.fs")!;
}

const DETAIL_PAGE = `
    page Detail {
      route: "/o/:id"
      state { sel: string = "" }
      action pick() { sel := string(id) }
      body: Button("go", onClick: pick)
    }`;

describe("feliz update path — the route `id`", () => {
  it("renders `id` in an action body instead of throwing", async () => {
    const fs = await app(DETAIL_PAGE);
    // The whole point: no `feliz: unsupported expression 'id'` throw, and the
    // assignment reads the route off the model rather than a phantom local.
    expect(fs).toContain("{ model with Sel = (string (routeId model.CurrentPage)) }");
  });

  it("emits the `routeId` accessor beside `parseUrl`, one arm per detail case", async () => {
    const fs = await app(DETAIL_PAGE);
    expect(fs).toContain(
      "let routeId (page: Page) : string =\n  match page with\n  | Detail id -> id",
    );
    // Every case here carries an id, so no wildcard arm (F# would flag a rule
    // that can never match).
    expect(fs).not.toContain('  | _ -> ""');
    // The accessor is declared before `update` uses it — F# is order-sensitive.
    expect(fs.indexOf("let routeId (page: Page)")).toBeLessThan(
      fs.indexOf("let update (msg: Msg)"),
    );
  });

  it("adds the wildcard arm when some page carries no route param", async () => {
    const fs = await app(`
    page Home { route: "/"  body: Text("home") }
    ${DETAIL_PAGE}`);
    expect(fs).toContain('  | Detail id -> id\n  | _ -> ""');
  });

  it("resolves `id` in a state initialiser off the current URL (`init` has no model)", async () => {
    const fs = await app(`
    page Detail {
      route: "/o/:id"
      state { sel: string = string(id) }
      body: Text(sel)
    }`);
    expect(fs).toContain("Sel = (string (routeId (parseUrl (Router.currentPath ()))))");
  });

  it("does NOT emit the accessor for a routed ui that never reads `id`", async () => {
    const fs = await app(`
    page Home { route: "/"  body: Text("home") }
    page About { route: "/about"  body: Text("about") }`);
    expect(fs).toContain("let parseUrl (segments: string list) : Page =");
    expect(fs).not.toContain("let routeId (page: Page)");
  });
});

describe("feliz update path — `duration`", () => {
  it("renders `days(7)` as the same TimeSpan the view path uses", async () => {
    const fs = await app(`
    page Sched {
      route: "/s"
      state { until: datetime = now() }
      action push() { until := now() + days(7) }
      body: Button("go", onClick: push)
    }`);
    // A duration is a `System.TimeSpan` on this target (the `exprDuration`
    // walker seam → `FS_LEAVES.duration`), spanning the same
    // `DURATION_UNIT_MS` milliseconds every backend agrees on; the update path
    // must agree with the view path, or `7 days` would mean two different
    // things inside one generated app.
    expect(fs).toContain(
      `(System.TimeSpan.FromMilliseconds(float (7) * ${DURATION_UNIT_MS.days}.0))`,
    );
    // ...and the datetime it is added to takes `.Add`, not `+` (F#'s
    // `System.DateTime` has no `+ TimeSpan` the walker could spell inline).
    expect(fs).toContain("(System.DateTime.UtcNow).Add(");
  });
});

describe("feliz update path — `new` (part construction)", () => {
  it("renders the F# anonymous record the view path emits for the same node", () => {
    // Not reachable from a page body today (`loom.unknown-builder-type` rejects
    // an entity-part name there), so the arm is exercised directly — the point
    // is that the update path no longer THROWS on a node the view path renders.
    const node: ExprIR = {
      kind: "new",
      partName: "Line",
      fields: [
        { name: "qty", value: { kind: "literal", lit: "int", value: "3" } },
        { name: "label", value: { kind: "literal", lit: "string", value: "a" } },
      ],
    };
    expect(renderFsExpr(node, { stateNames: new Set(), locals: new Set() })).toBe(
      '({| qty = 3; label = "a" |})',
    );
  });
});

describe("feliz update path — the remaining `default` throw", () => {
  it("still fails fast, and its message no longer claims total coverage", () => {
    // `this` is a domain-body receiver: a page has no aggregate instance, so the
    // frontend pipeline cannot produce it.  Fail fast rather than emit `()`.
    expect(() =>
      renderFsExpr({ kind: "this" }, { stateNames: new Set(), locals: new Set() }),
    ).toThrow(/unsupported expression 'this'/);
    // The old wording asserted every remaining kind was "unreachable on valid
    // frontend `.ddd`" — which is exactly what made `id` / `duration` crash
    // users instead of prompting an arm.
    let message = "";
    try {
      renderFsExpr({ kind: "this" }, { stateNames: new Set(), locals: new Set() });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("Unreachable");
    expect(message).toContain("implement the 'this' arm");
  });
});
