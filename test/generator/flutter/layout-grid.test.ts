// Flutter `Grid { … }` — the children-bearing container that used to lose its
// children AND emit uncompilable Dart.
//
// `_walker/primitives/layout.ts:emitGrid` was the only container primitive that
// never passed `childrenBlock` into the render context.  The `.hbs` packs never
// noticed (they iterate `{{#each children}}`, wrapping each child in its own
// column element), but the two PROCEDURAL packs read exactly that key through
// their shared container helpers.  Flutter's `childrenList` interpolates
// `c.childrenBlock ?? ""` into `<Widget>[\n<block>,\n]`, so an absent block
// produced `<Widget>[\n,\n]` — a BARE LEADING COMMA, which is a Dart syntax
// error, and no children either way.
//
// This pins both halves: the emitted list is syntactically valid and the
// children are actually in it.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Mobile {
  subdomain S { context Shop {
    aggregate Product { name: string }
    repository Products for Product {}
  } }
  ui App {
    framework: flutter
    page Home {
      route: "/"
      body: Stack {
        Grid { Card { "Tile A" }, Text { "Tile B" } },
        Section { Text { "after" } }
      }
    }
  }
  api A from S
  storage db { type: postgres }
  resource st { for: Shop, kind: state, use: db }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App port: 3006 }
}
`;

async function homePage(): Promise<string> {
  const files = await generateSystemFiles(SRC);
  const hit = [...files.entries()].find(([p]) => p.endsWith("lib/pages/home_page.dart"));
  expect(hit, "no lib/pages/home_page.dart emitted").toBeDefined();
  return hit![1];
}

describe("flutter Grid children", () => {
  it("emits no empty/leading-comma `<Widget>[` list anywhere on the page", async () => {
    const src = await homePage();
    // The exact shape the missing `childrenBlock` produced.  A list element may
    // never START with the separator — in Dart that is a parse error, not a
    // tolerated empty slot.
    expect(src, "Dart syntax error: `<Widget>[` opening on a bare comma").not.toMatch(
      /<Widget>\[\s*,/,
    );
  });

  it("renders the Grid's children inside its Wrap, not an empty list", async () => {
    const src = await homePage();
    // Flutter renders Grid as a `Wrap` of cells (a real GridView.count needs a
    // bounded height).  Locate it, then take its body up to the sibling that
    // follows the Grid in the page source.
    const wrapAt = src.indexOf("Wrap(spacing: 16, runSpacing: 16, children: <Widget>[");
    expect(wrapAt, "no Grid Wrap emitted").toBeGreaterThan(-1);
    const afterAt = src.indexOf("'after'", wrapAt);
    expect(afterAt, "no trailing Section after the Grid").toBeGreaterThan(wrapAt);
    const gridBody = src.slice(wrapAt, afterAt);

    // Not the empty-list degradation.
    expect(gridBody).not.toContain("children: <Widget>[]");
    // Both children are really in the Grid's list.
    expect(gridBody, "Grid dropped its Card child").toContain("Card(");
    expect(gridBody, "Grid dropped its Card child's title").toContain("'Tile A'");
    expect(gridBody, "Grid dropped its Text child").toContain("'Tile B'");
    // …comma-separated, as a Dart list literal requires (the walker's
    // `interChildSeparator` supplies the `,` between siblings).
    expect(gridBody).toMatch(/'Tile A'[\s\S]*\),\s*\n\s*Text\(/);
  });
});
