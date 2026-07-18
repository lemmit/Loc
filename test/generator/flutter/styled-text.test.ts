// Regression: a data-bound styled-text slot (Card title / Heading / Stat) must
// not double-wrap.  Flutter's `renderInterpolation` turns a non-literal like
// `p.name` into a `Text('${p.name}')` widget; a styled slot that blindly did
// `Text('${value}', style: …)` produced `Text('Text('${p.name}')', …)` — a Dart
// syntax error.  `styledText` styles an already-built widget via
// `DefaultTextStyle.merge` instead.  (Surfaced by the data-reads slice.)

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = `
system Styled {
  subdomain S { context Shop {
    aggregate Product { name: string  price: money }
    repository Products for Product {}
  } }
  ui App {
    framework: flutter
    api Shop: A
    page ProductList {
      route: "/"
      body: Stack {
        QueryView {
          of: Shop.Product.all,
          loading: Text { "…" }, error: Text { "e" }, empty: Text { "none" },
          data: rows => Stack { For { each: rows, p => Card { p.name, Text { p.price } } } }
        }
      }
    }
  }
  api A from S
  storage db { type: postgres }
  resource st { for: Shop, kind: state, use: db }
  deployable api1 { platform: node contexts: [Shop] dataSources: [st] serves: A port: 8081 }
  deployable app { platform: flutter targets: api1 ui: App { Shop: api1 } port: 3006 }
}
`;

describe("flutter styled-text (no double-wrap)", () => {
  it("renders a data-bound Card title without wrapping a Text widget in another Text", async () => {
    const files = await generateSystemFiles(SRC);
    const page = [...files.entries()].find(([k]) => k.endsWith("product_list_page.dart"));
    expect(page, "no product_list_page.dart emitted").toBeDefined();
    const src = page![1];

    // The bug signature: a Text literal whose body is itself a Text(...) call.
    expect(src).not.toContain("Text('Text(");
    // The fix: the member-access title is styled via DefaultTextStyle.merge.
    expect(src).toContain("DefaultTextStyle.merge(");
    expect(src).toContain("Text('${p.name}')");
  });
});
