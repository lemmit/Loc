import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// A user component invoked from ANOTHER component's body (ledger F2-FFE-4), and
// a user component invoked from a slot the design pack renders as a CHILD
// (ledger F2-CFE-7).
//
// Both were silent `dotnet fable` breakages:
//
//  * The emittability fixpoint in `component-emit.ts` seeded its name→params map
//    from each component's DECLARED params, so a nested call never saw the
//    synthetic `model` / `dispatch` markers `callSiteParams` adds and emitted a
//    bare `Counter {| … |}` where the function's signature demands
//    `Counter model dispatch {| … |}` (FS0001).
//  * A component application is neither `Html.…`-prefixed nor parenthesised, so
//    `felizPack`'s `isRenderedElement` classified it as raw TEXT and wrapped the
//    component's own F# SOURCE in a string literal — with its inner `"`
//    UNESCAPED, so `App.fs` did not even parse.
// ---------------------------------------------------------------------------

const sys = (uiBody: string) => `
  system S {
    subdomain M { context Sales {
      aggregate Thing { name: string }
      repository Things for Thing { }
    } }
    ui WebApp {
${uiBody}
    }
    storage primary { type: postgres }
    resource salesState { for: Sales, kind: state, use: primary }
    deployable api { platform: node contexts: [Sales] dataSources: [salesState] port: 3000 }
    deployable web { platform: feliz targets: api ui: WebApp port: 3005 }
  }
`;

async function appFs(source: string): Promise<string> {
  const files = await generateSystemFiles(source);
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

const NESTED = sys(`
      component Counter(label: string) {
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Text { label }, Text { string(n) }, Button { "+", onClick: bump } }
      }
      component Panel(heading: string) {
        state { open: bool = false }
        action toggle() { open := !open }
        body: Card { heading, Stack { Counter(label: "inner"), Button { "t", onClick: toggle } } }
      }
      page ThingList {
        route: "/things"
        body: Stack {
          Panel(heading: "outer"),
          QueryView { of: Thing.all, data: rows => Table {
            Column { "Name", r => Text { r.name } },
            Column { "Panel", r => Panel(heading: "in-cell") },
            rows: rows
          } }
        }
      }`);

describe("feliz — a component called from another component (F2-FFE-4)", () => {
  it("passes the curried model/dispatch a state+action component's signature demands", async () => {
    const fs = await appFs(NESTED);
    expect(fs).toContain(
      "let Counter (model: Model) (dispatch: Msg -> unit) (props: {| label: string |}) =",
    );
    // The nested call site, INSIDE Panel's body — the whole bug.
    expect(fs).toMatch(/let Panel[\s\S]*?\(Counter model dispatch \{\| label = "inner" \|\}\)/);
    // Panel itself gained `model` because it now HANDS one on — a component that
    // only dispatched its own action still needs the Model in scope.
    expect(fs).toContain(
      "let Panel (model: Model) (dispatch: Msg -> unit) (props: {| heading: string |}) =",
    );
    // Neither component was deferred as "needs MVU scope".
    expect(fs).not.toContain("unknown layout component: Panel");
    expect(fs).not.toContain("unknown layout component: Counter");
  });
});

describe("feliz — a component in a pack child slot (F2-CFE-7)", () => {
  it("renders the application as an element, never as an F# string literal", async () => {
    const fs = await appFs(NESTED);
    // The pre-fix emission: the whole application spliced into `Html.text "…"`,
    // whose inner quotes terminate the literal early.
    expect(fs).not.toMatch(/Html\.text "Panel/);
    // The Table cell for the `Panel` column.
    expect(fs).toContain('(Panel model dispatch {| heading = "in-cell" |})');
    // No F# string literal anywhere carries an unescaped inner quote run of the
    // props-record form.
    expect(fs).not.toContain('"Panel model dispatch {|');
  });
});
