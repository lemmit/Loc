// i18n user-visible-string extraction (M-T1.11, i18n.md Phase 1).
//
// `collectUiMessages` / `buildMessageCatalog` walk a UI's pages/components/menu
// and pull every plain string literal in a user-visible slot into a
// content-hash-keyed catalog entry.  These pin the two stability properties the
// key scheme (D-I18N-KEY) exists for — reorder-invariance and rephrase-rekey —
// plus role-in-key disambiguation and the dynamic-slot skip.

import { describe, expect, it } from "vitest";
import { collectUiMessages } from "../../../src/generator/_walker/i18n-extract.js";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { buildMessageCatalog } from "../../../src/system/i18n-catalog.js";
import { parseString } from "../../_helpers/parse.js";

async function catalogOf(source: string): Promise<Record<string, string>> {
  const { model } = await parseString(source, { validate: false });
  return buildMessageCatalog(enrichLoomModel(lowerModel(model)).systems[0]!);
}

const wrap = (uiBody: string) => `
  system T {
    subdomain S {
      context S {
        aggregate Order with crudish { status: string }
        repository Orders for Order { }
      }
    }
    api SApi from S
    ui Web {
      api S: SApi
      ${uiBody}
    }
  }
`;

describe("i18n message extraction", () => {
  it("extracts user-visible literals under content-hash keys", async () => {
    const cat = await catalogOf(
      wrap(`page Home {
        route: "/"
        body: Stack { Heading { "Welcome" }, Text { "Browse orders" }, Empty { "Nothing here" } }
      }`),
    );
    const byMessage = Object.entries(cat);
    expect(byMessage).toContainEqual([expect.stringMatching(/^page\.Home\.heading\./), "Welcome"]);
    expect(byMessage).toContainEqual([
      expect.stringMatching(/^page\.Home\.text\./),
      "Browse orders",
    ]);
    expect(byMessage).toContainEqual([
      expect.stringMatching(/^page\.Home\.empty\./),
      "Nothing here",
    ]);
  });

  it("is reorder-invariant — sibling order does not change the catalog", async () => {
    const a = await catalogOf(
      wrap(`page P { route: "/" body: Stack { Heading { "One" }, Text { "Two" } } }`),
    );
    const b = await catalogOf(
      wrap(`page P { route: "/" body: Stack { Text { "Two" }, Heading { "One" } } }`),
    );
    expect(a).toEqual(b);
  });

  it("re-keys on a rephrase — old key drops, new key appears (delete-old + add-new)", async () => {
    const before = await catalogOf(wrap(`page P { route: "/" body: Heading { "Orders" } }`));
    const after = await catalogOf(wrap(`page P { route: "/" body: Heading { "Order list" } }`));
    const [beforeKey] = Object.keys(before);
    const [afterKey] = Object.keys(after);
    expect(before[beforeKey!]).toBe("Orders");
    expect(after[afterKey!]).toBe("Order list");
    expect(afterKey).not.toBe(beforeKey);
    expect(after).not.toHaveProperty(beforeKey!);
  });

  it("distinguishes the same string in different slots by role", async () => {
    const cat = await catalogOf(
      wrap(`page P { route: "/" body: Stack { Heading { "Orders" }, Text { "Orders" } } }`),
    );
    const keys = Object.keys(cat);
    expect(keys).toHaveLength(2);
    expect(keys.some((k) => k.startsWith("page.P.heading."))).toBe(true);
    expect(keys.some((k) => k.startsWith("page.P.text."))).toBe(true);
    // Same string ⇒ the two keys share the trailing content hash.
    const hashes = keys.map((k) => k.split(".").pop());
    expect(hashes[0]).toBe(hashes[1]);
  });

  it("skips dynamic slots — a non-literal text arg is not extracted", async () => {
    const cat = await catalogOf(
      wrap(`page Show(o: Order) { route: "/x/:id" body: Heading { o.status } }`),
    );
    expect(Object.keys(cat)).toHaveLength(0);
  });

  it("extracts the page title and menu chrome", async () => {
    const cat = await catalogOf(
      wrap(`page Home {
        route: "/"
        title: "Dashboard"
        body: Heading { "Hi" }
      }
      menu { section "Reports" { link Home } }`),
    );
    const messages = Object.values(cat);
    expect(messages).toContain("Dashboard");
    expect(messages).toContain("Reports");
    expect(Object.keys(cat).some((k) => k.startsWith("page.Home.title."))).toBe(true);
    expect(Object.keys(cat).some((k) => k.startsWith("menu.section."))).toBe(true);
  });

  it("collectUiMessages is deterministic and pure", async () => {
    const { model } = await parseString(
      wrap(`page P { route: "/" body: Stack { Heading { "A" }, Text { "B" } } }`),
      { validate: false },
    );
    const ui = enrichLoomModel(lowerModel(model)).systems[0]!.uis[0]!;
    expect(collectUiMessages(ui)).toEqual(collectUiMessages(ui));
  });
});
