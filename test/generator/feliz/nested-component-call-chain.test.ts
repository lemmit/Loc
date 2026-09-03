import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// Nested user-component call CHAINS — Feliz (`feliz/component-emit.ts`).
//
// `nested-component-call.test.ts` next door pins the one-level case: a
// component that reads state or dispatches takes the `Model` / `dispatch` as
// LEADING CURRIED params, and a call from ANOTHER component's body has to spell
// them (`Counter model dispatch {| … |}`, not the bare `Counter {| … |}` F#
// reads as an anonymous record where a `Model` is expected — FS0001).
//
// These are the two properties one level cannot show, and that the fixpoint in
// `emitFelizUserComponents` is what buys:
//
//   * TRANSITIVITY across more than one hop.  The marker is discovered in the
//     round that renders the callee, so a three-deep chain needs the loop to run
//     until the call-site param MAP is stable, not merely until the candidate
//     SET is.  A single-level test passes against a one-round implementation.
//   * The masking is SCOPED.  Only a marker-bearing callee's `model`/`dispatch`
//     are blanked before the MVU-scope scan, so a caller of a purely stateless
//     sibling gains no leading args it has no use for — the over-masking
//     regression a one-level test cannot see either.
// ---------------------------------------------------------------------------

const sys = (uiBody: string) => `
  system S {
    subdomain M { context Sales {
      aggregate Order { customerId: string }
      repository Orders for Order { }
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

const COUNTER = `
      component Counter(caption: string) {
        state { n: int = 0 }
        action bump() { n := n + 1 }
        body: Stack { Text { caption }, Text { string(n) }, Button(label: "+", onClick: bump) }
      }`;

describe("nested user-component call chains — Feliz", () => {
  it("propagates through two levels of nesting", async () => {
    const fs = await appFs(
      sys(`${COUNTER}
      component Inner(heading: string) {
        body: Stack { Text { heading }, Counter(caption: "deep") }
      }
      component Outer(title: string) {
        body: Stack { Text { title }, Inner(heading: "mid") }
      }
      page Home { route: "/" body: Stack { Outer(title: "t") } }`),
    );
    expect(fs).toContain('Counter model dispatch {| caption = "deep" |}');
    expect(fs).toContain('Inner model dispatch {| heading = "mid" |}');
    expect(fs).toContain('Outer model dispatch {| title = "t" |}');
    // Every hop declares what its call sites pass — no half-threaded chain.
    for (const n of ["Counter", "Inner", "Outer"]) {
      expect(fs).toContain(`    let ${n} (model: Model) (dispatch: Msg -> unit) (props:`);
    }
  });

  it("a nested call to a plain component still takes no leading args", async () => {
    // The masking is scoped to MARKER-bearing callees, so a stateless sibling is
    // untouched — and its caller gains no `model` it has no use for.
    const fs = await appFs(
      sys(`
      component Ribbon(label: string) { body: Text { label } }
      component Panel(heading: string) {
        body: Stack { Text { heading }, Ribbon(label: "r") }
      }
      page Home { route: "/" body: Panel(heading: "p") }`),
    );
    expect(fs).toContain('Ribbon {| label = "r" |}');
    expect(fs).toContain("    let Panel (props: {| heading: string |}) =");
    expect(fs).toContain('Panel {| heading = "p" |}');
  });
});
