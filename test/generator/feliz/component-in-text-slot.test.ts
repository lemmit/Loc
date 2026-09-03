import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// A user-component call landing in a text-OR-markup slot — Feliz
// (`feliz/pack.ts`'s `isRenderedElement`, `feliz-target.ts`'s
// `renderUserComponent` / `renderChildrenSlot`).
//
// ~20 pack slots take a value that is EITHER raw text or an already-rendered
// element (a `Table` `Column` cell, a `DescriptionList` value, a `Link` label, a
// `Card` title, `Stat`'s label/value, …) and branch on a PREFIX test:
// `Html.`-or-`(` means element, anything else gets wrapped as
// `Html.text "<value>"`.  Raw text has been through the target's `escapeText`,
// so it rides an F# string body safely — but a user-component application came
// back as a bare `Panel {| heading = "in-cell" |}`, which failed the prefix test
// and was emitted as
//
//     Html.text "Panel {| heading = "in-cell" |}"
//
// — an F# string literal with UNESCAPED inner quotes.  App.fs does not PARSE,
// so nothing else the backend emitted mattered.
//
// The fix is at the producer, not the predicate: a component application (and a
// `Slot { }` read) is paren-wrapped, which makes "every Feliz element starts
// with `Html.` or `(`" an invariant instead of a guess.  Widening the predicate
// was not an option — a plain cell reading `Order total` is text, and no prefix
// tells the two apart.
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

async function appFs(uiBody: string): Promise<string> {
  const files = await generateSystemFiles(sys(uiBody));
  return [...files.entries()].find(([p]) => p.endsWith("src/App.fs"))![1];
}

/** Every F# string literal in the source, with escapes honoured — an unescaped
 *  `"` inside one is exactly the defect under test. */
function unbalancedStringLiterals(fs: string): string[] {
  return fs.split("\n").filter((l) => {
    const quotes = l.match(/(^|[^\\])"/g) ?? [];
    return quotes.length % 2 === 1;
  });
}

describe("a user component in a text-or-markup slot — Feliz", () => {
  it("is not wrapped in an F# string literal when it sits in a Table cell", async () => {
    const fs = await appFs(`
      component Panel(heading: string) { body: Text { heading } }
      page Things {
        route: "/things"
        state { rows: Thing[] = Api.Things.all }
        body: Table(Column("Panel", t => Panel(heading: "in-cell")), rows: rows)
      }`);
    // The assertion that fails on `main`: the call is emitted as visible text,
    // inside a string literal whose inner quotes are unescaped.
    expect(fs).not.toContain('Html.text "Panel {|');
    // It is an ELEMENT in the cell's children list.
    expect(fs).toContain('Html.td [ prop.children [ (Panel {| heading = "in-cell" |}) ] ]');
    // …and App.fs still has no line with an odd number of unescaped quotes.
    expect(unbalancedStringLiterals(fs)).toEqual([]);
  });

  it("is not wrapped in an F# string literal in a KeyValueRow value", async () => {
    const fs = await appFs(`
      component Panel(heading: string) { body: Text { heading } }
      page Home {
        route: "/"
        body: KeyValueRow { "P", Panel(heading: "dl") }
      }`);
    expect(fs).not.toContain('Html.text "Panel {|');
    expect(fs).toContain('(Panel {| heading = "dl" |})');
    expect(unbalancedStringLiterals(fs)).toEqual([]);
  });

  it("keeps raw text on the text branch — the predicate is not widened", async () => {
    // The counterexample that rules out "recognise a capitalised identifier":
    // this cell IS text, and has to stay `Html.text "…"`.
    const fs = await appFs(`
      page Things {
        route: "/things"
        state { rows: Thing[] = Api.Things.all }
        body: Table(Column("Label", t => "Order total"), rows: rows)
      }`);
    expect(fs).toContain('Html.text "Order total"');
  });

  it("paren-wraps a `Slot { }` read for the same reason", async () => {
    const fs = await appFs(`
      component Frame(title: string) { body: Card { Slot { } } }
      page Home { route: "/" body: Frame("t", Text { "inside" }) }`);
    expect(fs).toContain("(props.children)");
    expect(fs).not.toContain('Html.text "props.children"');
    expect(unbalancedStringLiterals(fs)).toEqual([]);
  });
});
