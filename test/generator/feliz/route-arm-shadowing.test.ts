import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// `parseUrl` arm SHADOWING — Feliz (`feliz/index.ts`).
//
// F# matches list patterns top-to-bottom and a `:param` segment becomes a
// binder that matches ANY segment, so an arm whose pattern is COVERED by an
// earlier one is an unreachable rule — `warning FSHARP: This rule will never be
// matched (code 26)` — and the app is then silently wrong: `/things/new` parses
// as the DETAIL page for the record whose id is the string `"new"`.
//
// `route-match-order.test.ts` next door pins the two-segment reproducer that
// motivated the sort.  This file pins the three properties that make the
// ordering a RULE rather than a fix for that one shape — none of which a single
// two-segment example can show:
//
//   * The shadow is caught when it is invisible at segment 0.  `/:kind/:id/edit`
//     covers `/things/:id/edit`, but the two agree on nothing until position 0
//     is compared as literal-vs-binder, and declaration order alone puts the
//     shadower first.
//   * A ui that is ALREADY ordered correctly is byte-identical — the sort is a
//     no-op there, not a churn of the emitted arms.
//   * Routes of DIFFERENT segment counts are never reordered.  Two list patterns
//     of different lengths are disjoint in F#, so neither can shadow the other
//     and declaration order is preserved rather than swept up by a global
//     "literals first" sort.
// ---------------------------------------------------------------------------

const sys = (uiBody: string) => `
  system S {
    subdomain M { context Sales {
      aggregate Thing { title: string }
      repository Things for Thing { }
    } }
    api SalesApi from M
    ui WebApp {
      api Sales: SalesApi
${uiBody}
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node contexts: [Sales] serves: SalesApi dataSources: [salesState] port: 3000 }
    deployable web { platform: feliz targets: api ui: WebApp { Sales: api } port: 3005 }
  }
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

/** The `parseUrl` arms, in emitted order. */
function parseUrlArms(fs: string): string[] {
  const body = fs.slice(fs.indexOf("let parseUrl"));
  return body
    .slice(0, body.indexOf("| _ ->"))
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("| ["));
}

describe("parseUrl arm shadowing — Feliz", () => {
  it("orders a three-segment shadow the declaration order gets wrong", async () => {
    // `[ kind; id; "edit" ]` matches everything `[ "things"; id; "edit" ]` does,
    // so declaring it first makes the specific arm an unreachable F# rule.
    const fs = await appFs(
      sys(`
      page Home { route: "/" body: Text { "home" } }
      page AnyEdit { route: "/:kind/:id/edit" body: Text { "any" } }
      page ThingEdit { route: "/things/:id/edit" body: Text { "thing" } }`),
    );
    const arms = parseUrlArms(fs);
    const specific = arms.findIndex((a) => a.includes('[ "things"; id; "edit" ]'));
    const shadow = arms.findIndex((a) => a.includes('[ kind; id; "edit" ]'));
    expect(specific).toBeGreaterThanOrEqual(0);
    expect(shadow).toBeGreaterThanOrEqual(0);
    expect(specific).toBeLessThan(shadow);
  });

  it("leaves an already-specific-first ui byte-identical", async () => {
    const fs = await appFs(
      sys(`
      page Home { route: "/" body: Text { "home" } }
      page ThingNew { route: "/things/new" body: Text { "new" } }
      page ThingDetail { route: "/things/:id" body: Text { "detail" } }`),
    );
    expect(parseUrlArms(fs)).toEqual([
      "| [] -> Home",
      '| [ "things"; "new" ] -> ThingNew',
      '| [ "things"; id ] -> ThingDetail id',
    ]);
  });

  it("does not reorder routes of different segment counts", async () => {
    const fs = await appFs(
      sys(`
      page ThingDetail { route: "/things/:id" body: Text { "detail" } }
      page Things { route: "/things" body: Text { "list" } }
      page Home { route: "/" body: Text { "home" } }`),
    );
    expect(parseUrlArms(fs)).toEqual([
      '| [ "things"; id ] -> ThingDetail id',
      '| [ "things" ] -> Things',
      "| [] -> Home",
    ]);
  });
});
