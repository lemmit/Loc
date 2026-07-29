// UI-DECLARATION editing for the playground page builder.
//
// Sibling of `page-props.test.ts`: `ui-decl.ts` edits the `ui { … }` members
// that sit BESIDE the pages — `store` (incl. its `persist:` clause and its
// `state { }` fields), the `area { }` grouping, and the ui-level
// `menu { section … }` sidebar — through the same narrow-CST-splice
// discipline.  Assertions go through `lineDiff` (the builder's own hunk
// differ) to pin exactly which line(s) changed; a whole-ui reprint would fail
// every one of these.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { isMenuLink } from "../../../src/language/generated/ast.js";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  addArea,
  addMenuLink,
  addMenuSection,
  addStore,
  addStoreField,
  deleteMenuLink,
  deleteMenuSection,
  deleteStore,
  deleteStoreField,
  listAreas,
  listStoreFields,
  listStores,
  menuInfo,
  menuLinkTargets,
  movePageToArea,
  renameArea,
  retypeStoreField,
  setStorePersist,
} from "../../../web/src/builder/page/ui-decl.js";
import { parseDdd } from "../../../web/src/builder/parse.js";
import type { TypeSpec } from "../../../web/src/builder/system/fields.js";
import { parseString } from "../../_helpers/index.js";

// A fully-decorated ui: two stores (one with `persist:`), a nested area tree,
// a root page, an explicit sidebar menu — and comments in every one of them,
// which any reprint would eat.
const FULL = `system S {
  ui U {
    // the shopping cart
    store Cart persist: local {
      state {
        // one sku per line
        lines: string[]
        count: int = 0
      }
      action clear() {
        count := 0
      }
    }
    store Prefs {
      state {
        zoom: int
      }
    }
    // grouped pages
    area Orders {
      // the list page
      page List {
        route: "/orders"
        body: Text { "orders" }
      }
      area Archive {
        page Old {
          body: Text { "old" }
        }
      }
    }
    page Home {
      body: Text { "home" }
    }
    menu {
      section "Ops" {
        link Home,
        link "Docs" -> "https://docs.example.com"
      }
      section "Lookup" {
        link Home
      }
    }
  }
}`;

// A bare ui — one page, no store / area / menu at all: the "create the first
// one" path for every add op.
const LEAN = `system S {
  ui U {
    // the only page
    page Home {
      body: Text { "home" }
    }
  }
}`;

// Two `ui`s — drives the `uiName` selector (and its unknown-name refusal).
const TWO_UIS = `system S {
  ui A {
    store Cart {
      state {
        count: int = 0
      }
    }
    page Home {
      body: Text { "a" }
    }
  }
  ui B {
    page Home {
      body: Text { "b" }
    }
  }
}`;

// A source the parser rejects — every entry point must refuse it rather than
// splice at offsets the error-recovery parser invented.
const BROKEN = LEAN.replace("page Home {", "page Home {{");

const FULL_COMMENTS = [
  "// the shopping cart",
  "// one sku per line",
  "// grouped pages",
  "// the list page",
];

const INT: TypeSpec = { base: { kind: "primitive", name: "int" }, array: false, optional: false };

const expectCommentsIntact = (out: string | null, comments: string[]): void => {
  expect(out).not.toBeNull();
  for (const c of comments) expect(out).toContain(c);
};

const expectHunk = (
  before: string,
  after: string | null,
  removed: string[],
  added: string[],
): void => {
  expect(after).not.toBeNull();
  const hunk = lineDiff(before, after as string);
  expect({ removed: hunk.removed, added: hunk.added }).toEqual({ removed, added });
};

/** Output guard, asserted independently of the module's own re-parse. */
const expectParses = (out: string | null): string => {
  expect(out).not.toBeNull();
  expect(parseDdd(out as string).parserErrors).toHaveLength(0);
  return out as string;
};

describe("page builder — ui stores read-back", () => {
  it("lists every store with its persist mode and member counts", () => {
    expect(listStores(FULL)).toEqual([
      { name: "Cart", persist: "local", fieldCount: 2, actionCount: 1 },
      { name: "Prefs", fieldCount: 1, actionCount: 0 },
    ]);
  });

  it("lists a store's state fields with their types and defaults", () => {
    expect(listStoreFields(FULL, "U", "Cart")).toEqual([
      {
        name: "lines",
        base: { kind: "primitive", name: "string" },
        baseLabel: "string",
        array: true,
        optional: false,
      },
      {
        name: "count",
        base: { kind: "primitive", name: "int" },
        baseLabel: "int",
        array: false,
        optional: false,
        init: "0",
      },
    ]);
  });

  it("selects the ui by name, and returns null for an unknown one", () => {
    expect(listStores(TWO_UIS, "A")?.map((s) => s.name)).toEqual(["Cart"]);
    expect(listStores(TWO_UIS, "B")).toEqual([]);
    // Without a name the first ui wins, like the page-props disambiguator.
    expect(listStores(TWO_UIS)?.map((s) => s.name)).toEqual(["Cart"]);
    expect(listStores(TWO_UIS, "Nope")).toBeNull();
  });

  it("returns null on unparseable source, and for an unknown store", () => {
    expect(listStores(BROKEN)).toBeNull();
    expect(listStoreFields(BROKEN, "U", "Cart")).toBeNull();
    expect(listStoreFields(FULL, "U", "Nope")).toBeNull();
  });
});

describe("page builder — store add / delete / persist", () => {
  it("addStore opens the first store in a ui that has none", () => {
    const out = addStore(LEAN, "U", "Cart");
    expectHunk(LEAN, out, [], ["    store Cart {", "    }"]);
    expect(listStores(expectParses(out))).toEqual([
      { name: "Cart", fieldCount: 0, actionCount: 0 },
    ]);
    expectCommentsIntact(out, ["// the only page"]);
  });

  it("addStore groups a new store after the last existing one", () => {
    const out = addStore(FULL, "U");
    expectHunk(FULL, out, [], ["    store Store1 {", "    }"]);
    expect(listStores(expectParses(out))?.map((s) => s.name)).toEqual(["Cart", "Prefs", "Store1"]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("addStore generates a fresh name, skipping the taken ones", () => {
    const first = expectParses(addStore(LEAN, "U"));
    expect(listStores(first)?.map((s) => s.name)).toEqual(["Store1"]);
    const second = expectParses(addStore(first, "U"));
    expect(listStores(second)?.map((s) => s.name)).toEqual(["Store1", "Store2"]);
  });

  it("addStore refuses a duplicate name or a non-identifier", () => {
    expect(addStore(FULL, "U", "Cart")).toBeNull();
    expect(addStore(FULL, "U", "not an id")).toBeNull();
    expect(addStore(BROKEN, "U", "Cart")).toBeNull();
    expect(addStore(LEAN, "Nope", "Cart")).toBeNull();
  });

  it("deleteStore removes only that store's lines", () => {
    const out = deleteStore(FULL, "U", "Prefs");
    expectHunk(
      FULL,
      out,
      ["    store Prefs {", "      state {", "        zoom: int", "      }", "    }"],
      [],
    );
    expect(listStores(expectParses(out))?.map((s) => s.name)).toEqual(["Cart"]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("deleteStore returns null for an unknown store or a broken source", () => {
    expect(deleteStore(FULL, "U", "Nope")).toBeNull();
    expect(deleteStore(BROKEN, "U", "Cart")).toBeNull();
  });

  it("setStorePersist replaces the mode in place", () => {
    const out = setStorePersist(FULL, "U", "Cart", "session");
    expectHunk(
      FULL,
      out,
      ["    store Cart persist: local {"],
      ["    store Cart persist: session {"],
    );
    expect(listStores(expectParses(out))?.[0].persist).toBe("session");
  });

  it("setStorePersist adds the clause after the store name", () => {
    const out = setStorePersist(FULL, "U", "Prefs", "url");
    expectHunk(FULL, out, ["    store Prefs {"], ["    store Prefs persist: url {"]);
    expect(listStores(expectParses(out))?.[1].persist).toBe("url");
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("setStorePersist(null) swallows the whole clause", () => {
    const out = setStorePersist(FULL, "U", "Cart", null);
    expectHunk(FULL, out, ["    store Cart persist: local {"], ["    store Cart {"]);
    expect(listStores(expectParses(out))?.[0].persist).toBeUndefined();
  });

  it("setStorePersist(null) on a store without one is a no-op", () => {
    expect(setStorePersist(FULL, "U", "Prefs", null)).toBe(FULL);
  });

  it("setStorePersist returns null for an unknown mode, store or broken source", () => {
    expect(setStorePersist(FULL, "U", "Cart", "cookie" as "url")).toBeNull();
    expect(setStorePersist(FULL, "U", "Nope", "url")).toBeNull();
    expect(setStorePersist(BROKEN, "U", "Cart", "url")).toBeNull();
  });
});

describe("page builder — store state fields", () => {
  it("addStoreField appends one line to the existing block", () => {
    const out = addStoreField(FULL, "U", "Cart");
    expectHunk(FULL, out, [], ["        field1: string"]);
    expect(listStoreFields(expectParses(out), "U", "Cart")?.map((f) => f.name)).toEqual([
      "lines",
      "count",
      "field1",
    ]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("addStoreField opens a state block when the store has none", () => {
    const bare = expectParses(addStore(LEAN, "U", "Cart"));
    const out = addStoreField(bare, "U", "Cart", INT);
    expectHunk(bare, out, [], ["      state {", "        field1: int", "      }"]);
    expect(listStoreFields(expectParses(out), "U", "Cart")?.[0].baseLabel).toBe("int");
  });

  it("deleteStoreField removes one field line", () => {
    const out = deleteStoreField(FULL, "U", "Cart", 1);
    expectHunk(FULL, out, ["        count: int = 0"], []);
    expect(listStoreFields(expectParses(out), "U", "Cart")?.map((f) => f.name)).toEqual(["lines"]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("retypeStoreField rewrites only the type, keeping the default", () => {
    const out = retypeStoreField(FULL, "U", "Cart", 1, {
      base: { kind: "primitive", name: "decimal" },
      array: false,
      optional: false,
    });
    expectHunk(FULL, out, ["        count: int = 0"], ["        count: decimal = 0"]);
    expect(listStoreFields(expectParses(out), "U", "Cart")?.[1].init).toBe("0");
  });

  it("field ops return null for an unknown store / index / broken source", () => {
    expect(addStoreField(BROKEN, "U", "Cart")).toBeNull();
    expect(addStoreField(FULL, "U", "Nope")).toBeNull();
    expect(deleteStoreField(FULL, "U", "Cart", 9)).toBeNull();
    expect(retypeStoreField(FULL, "U", "Nope", 0, INT)).toBeNull();
  });
});

describe("page builder — areas", () => {
  it("lists the nested area tree with its page names", () => {
    expect(listAreas(FULL)).toEqual({
      rootPages: ["Home"],
      areas: [
        {
          name: "Orders",
          path: ["Orders"],
          pages: ["List"],
          areas: [{ name: "Archive", path: ["Orders", "Archive"], pages: ["Old"], areas: [] }],
        },
      ],
    });
  });

  it("listAreas returns null on unparseable source or an unknown ui", () => {
    expect(listAreas(BROKEN)).toBeNull();
    expect(listAreas(FULL, "Nope")).toBeNull();
    expect(listAreas(LEAN)).toEqual({ rootPages: ["Home"], areas: [] });
  });

  it("addArea opens the first area at the ui root", () => {
    const out = addArea(LEAN, "U", "Admin");
    expectHunk(LEAN, out, [], ["    area Admin {", "    }"]);
    expect(listAreas(expectParses(out))?.areas.map((a) => a.name)).toEqual(["Admin"]);
    expectCommentsIntact(out, ["// the only page"]);
  });

  it("addArea nests under a named parent area", () => {
    const out = addArea(FULL, "U", "Draft", "Orders");
    expectHunk(FULL, out, [], ["      area Draft {", "      }"]);
    expect(listAreas(expectParses(out))?.areas[0].areas.map((a) => a.name)).toEqual([
      "Archive",
      "Draft",
    ]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("addArea refuses a duplicate sibling, a bad name, an unknown parent", () => {
    expect(addArea(FULL, "U", "Orders")).toBeNull();
    expect(addArea(FULL, "U", "Archive", "Orders")).toBeNull();
    expect(addArea(FULL, "U", "not an id")).toBeNull();
    expect(addArea(FULL, "U", "Draft", "Nope")).toBeNull();
    expect(addArea(BROKEN, "U", "Admin")).toBeNull();
  });

  it("renameArea rewrites the bare ID only", () => {
    // `Archive` carries no qualified menu link, so the rename goes through.
    const out = renameArea(FULL, "U", "Archive", "Cold");
    expectHunk(FULL, out, ["      area Archive {"], ["      area Cold {"]);
    expect(listAreas(expectParses(out))?.areas[0].areas[0].path).toEqual(["Orders", "Cold"]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("renameArea REFUSES an area a qualified menu link resolves through", () => {
    // The area name is part of the `link Orders.List` reference TEXT; fixing
    // every referring link is a rename refactoring, not a narrow splice — so
    // the op refuses rather than silently breaking the link.
    const linked = expectParses(addMenuLink(FULL, "U", "Ops", { page: "Orders.List" }));
    expect(renameArea(linked, "U", "Orders", "Sales")).toBeNull();
    // The unqualified sibling stays renameable.
    expect(renameArea(linked, "U", "Archive", "Cold")).not.toBeNull();
  });

  it("renameArea refuses a bad name, a sibling collision, an unknown area", () => {
    const two = expectParses(addArea(FULL, "U", "Admin"));
    expect(renameArea(two, "U", "Admin", "Orders")).toBeNull();
    expect(renameArea(FULL, "U", "Orders", "not an id")).toBeNull();
    expect(renameArea(FULL, "U", "Nope", "X")).toBeNull();
    expect(renameArea(BROKEN, "U", "A", "B")).toBeNull();
    expect(renameArea(FULL, "U", "Orders", "Orders")).toBe(FULL);
  });
});

describe("page builder — moving a page between areas", () => {
  // The exact source text of `page Home` in FULL, including its indentation
  // shape — the bytes `movePageToArea` must not touch.
  const HOME = ["    page Home {", '      body: Text { "home" }', "    }"];

  it("moves a root page into an area, byte-for-byte", () => {
    const out = movePageToArea(FULL, "U", "Home", "Orders");
    expectParses(out);
    // Cut from the ui root, re-inserted as the area's last member: the page's
    // own bytes are carried over untouched (no re-indentation, no reprint), so
    // the only other line in the hunk is the area's closing brace, now below
    // the page instead of above it.
    const hunk = lineDiff(FULL, out as string);
    expect({ removed: hunk.removed, added: hunk.added }).toEqual({
      removed: ["    }", ...HOME.slice(0, 2)],
      added: ["      page Home {", '      body: Text { "home" }', "    }"],
    });
    // The cut span itself, character for character.
    expect(out).toContain(HOME.join("\n").slice(4));
    expect(listAreas(out as string)).toMatchObject({
      rootPages: [],
      areas: [{ name: "Orders", pages: ["List", "Home"] }],
    });
    // Nothing else in the ui moved.
    expectCommentsIntact(out, FULL_COMMENTS);
    expect(menuInfo(out as string)).toEqual(menuInfo(FULL));
    expect(listStores(out as string)).toEqual(listStores(FULL));
  });

  it("carries the page's own comments — leading and interior — along", () => {
    const out = expectParses(movePageToArea(FULL, "U", "List", null));
    // The `// the list page` comment travelled with the page out to the root.
    expect(out).toContain('    // the list page\n      page List {\n        route: "/orders"');
    expect(listAreas(out)).toMatchObject({ rootPages: ["Home", "List"] });
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("moves a page out to the ui root", () => {
    const out = expectParses(movePageToArea(FULL, "U", "Old", null));
    expect(listAreas(out)).toMatchObject({
      rootPages: ["Home", "Old"],
      areas: [{ name: "Orders", areas: [{ name: "Archive", pages: [] }] }],
    });
  });

  it("moves a page between two areas", () => {
    const out = expectParses(movePageToArea(FULL, "U", "List", "Archive"));
    expect(listAreas(out)).toMatchObject({
      areas: [{ name: "Orders", pages: [], areas: [{ name: "Archive", pages: ["Old", "List"] }] }],
    });
  });

  it("is a no-op when the page already sits in the target", () => {
    expect(movePageToArea(FULL, "U", "Home", null)).toBe(FULL);
    expect(movePageToArea(FULL, "U", "List", "Orders")).toBe(FULL);
  });

  it("REFUSES a move that would break an area-qualified menu link", () => {
    const linked = expectParses(addMenuLink(FULL, "U", "Ops", { page: "Orders.List" }));
    expect(movePageToArea(linked, "U", "List", null)).toBeNull();
    // A bare `link Home` resolves from anywhere in the ui, so moving that page
    // stays allowed.
    expect(movePageToArea(linked, "U", "Home", "Orders")).not.toBeNull();
  });

  it("returns null for an unknown page / area / ui / broken source", () => {
    expect(movePageToArea(FULL, "U", "Nope", "Orders")).toBeNull();
    expect(movePageToArea(FULL, "U", "Home", "Nope")).toBeNull();
    expect(movePageToArea(FULL, "Nope", "Home", null)).toBeNull();
    expect(movePageToArea(BROKEN, "U", "Home", null)).toBeNull();
  });
});

describe("page builder — ui menu block", () => {
  it("reads the sections and both link forms", () => {
    expect(menuInfo(FULL)).toEqual({
      hasMenu: true,
      sections: [
        {
          label: "Ops",
          entries: [
            { kind: "page", page: "Home" },
            { kind: "external", label: "Docs", url: "https://docs.example.com" },
          ],
        },
        { label: "Lookup", entries: [{ kind: "page", page: "Home" }] },
      ],
    });
    expect(menuInfo(LEAN)).toEqual({ hasMenu: false, sections: [] });
    expect(menuInfo(BROKEN)).toBeNull();
    expect(menuInfo(FULL, "Nope")).toBeNull();
  });

  it("lists the link targets a ui's menu scope can resolve", () => {
    expect(menuLinkTargets(FULL)).toEqual([
      "List",
      "Orders.List",
      "Old",
      "Orders.Archive.Old",
      "Home",
    ]);
    expect(menuLinkTargets(BROKEN)).toBeNull();
  });

  it("creates the menu block with the first section", () => {
    const out = addMenuSection(LEAN, "U", "Admin");
    expectHunk(LEAN, out, [], ["    menu {", '      section "Admin" {', "      }", "    }"]);
    expect(menuInfo(expectParses(out))).toEqual({
      hasMenu: true,
      sections: [{ label: "Admin", entries: [] }],
    });
    expectCommentsIntact(out, ["// the only page"]);
  });

  it("appends a section to the existing block", () => {
    const out = addMenuSection(FULL, "U", "Admin");
    expectHunk(FULL, out, [], ['      section "Admin" {', "      }"]);
    expect(menuInfo(expectParses(out))?.sections.map((s) => s.label)).toEqual([
      "Ops",
      "Lookup",
      "Admin",
    ]);
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("refuses a duplicate / empty section label and a broken source", () => {
    expect(addMenuSection(FULL, "U", "Ops")).toBeNull();
    expect(addMenuSection(FULL, "U", "  ")).toBeNull();
    expect(addMenuSection(BROKEN, "U", "Ops")).toBeNull();
    expect(addMenuSection(FULL, "Nope", "Ops")).toBeNull();
  });

  it("deletes one section, leaving the block", () => {
    const out = deleteMenuSection(FULL, "U", "Lookup");
    expectHunk(FULL, out, ['      section "Lookup" {', "        link Home", "      }"], []);
    expect(menuInfo(expectParses(out))?.sections.map((s) => s.label)).toEqual(["Ops"]);
  });

  it("drops the whole menu block with its last section", () => {
    const one = expectParses(deleteMenuSection(FULL, "U", "Lookup"));
    const out = deleteMenuSection(one, "U", "Ops");
    expectHunk(
      one,
      out,
      [
        "    menu {",
        '      section "Ops" {',
        "        link Home,",
        '        link "Docs" -> "https://docs.example.com"',
        "      }",
        "    }",
      ],
      [],
    );
    expect(menuInfo(expectParses(out))).toEqual({ hasMenu: false, sections: [] });
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("round-trips create → drop → create of the block", () => {
    const created = expectParses(addMenuSection(LEAN, "U", "Admin"));
    const dropped = expectParses(deleteMenuSection(created, "U", "Admin"));
    expect(dropped).toBe(LEAN);
    expect(menuInfo(expectParses(addMenuSection(dropped, "U", "Ops")))?.hasMenu).toBe(true);
  });

  it("deleteMenuSection returns null for an unknown section / broken source", () => {
    expect(deleteMenuSection(FULL, "U", "Nope")).toBeNull();
    expect(deleteMenuSection(LEAN, "U", "Ops")).toBeNull();
    expect(deleteMenuSection(BROKEN, "U", "Ops")).toBeNull();
  });

  it("adds a page link to an empty section, then a second one after a comma", () => {
    const withSection = expectParses(addMenuSection(FULL, "U", "Admin"));
    const first = addMenuLink(withSection, "U", "Admin", { page: "Orders.List" });
    expectHunk(withSection, first, [], ["        link Orders.List"]);
    const second = addMenuLink(expectParses(first), "U", "Admin", { page: "Home" });
    expectHunk(
      first as string,
      second,
      ["        link Orders.List"],
      ["        link Orders.List,", "        link Home"],
    );
    expect(menuInfo(expectParses(second))?.sections[2]).toEqual({
      label: "Admin",
      entries: [
        { kind: "page", page: "Orders.List" },
        { kind: "page", page: "Home" },
      ],
    });
  });

  it("adds an external link with both strings quoted", () => {
    const out = addMenuLink(FULL, "U", "Lookup", {
      label: "Status",
      url: "https://status.example.com",
    });
    expectHunk(
      FULL,
      out,
      ["        link Home"],
      ["        link Home,", '        link "Status" -> "https://status.example.com"'],
    );
    expect(menuInfo(expectParses(out))?.sections[1].entries[1]).toEqual({
      kind: "external",
      label: "Status",
      url: "https://status.example.com",
    });
  });

  it("refuses a link to a page the menu scope cannot resolve", () => {
    expect(addMenuLink(FULL, "U", "Ops", { page: "Nope" })).toBeNull();
    // `List` lives in an area — the bare name resolves, the wrong path doesn't.
    expect(addMenuLink(FULL, "U", "Ops", { page: "List" })).not.toBeNull();
    expect(addMenuLink(FULL, "U", "Ops", { page: "Archive.List" })).toBeNull();
    expect(addMenuLink(FULL, "U", "Nope", { page: "Home" })).toBeNull();
    expect(addMenuLink(FULL, "U", "Ops", { label: "", url: "https://x" })).toBeNull();
    expect(addMenuLink(BROKEN, "U", "Ops", { page: "Home" })).toBeNull();
  });

  it("deletes a trailing / middle / first / only link with its separator", () => {
    const last = deleteMenuLink(FULL, "U", "Ops", 1);
    expectHunk(
      FULL,
      last,
      ["        link Home,", '        link "Docs" -> "https://docs.example.com"'],
      ["        link Home"],
    );
    const first = deleteMenuLink(FULL, "U", "Ops", 0);
    expectHunk(FULL, first, ["        link Home,"], []);
    expect(menuInfo(expectParses(first))?.sections[0].entries).toEqual([
      { kind: "external", label: "Docs", url: "https://docs.example.com" },
    ]);
    const only = deleteMenuLink(FULL, "U", "Lookup", 0);
    expectHunk(FULL, only, ["        link Home"], []);
    expect(menuInfo(expectParses(only))?.sections[1]).toEqual({ label: "Lookup", entries: [] });
  });

  it("deleteMenuLink returns null for an unknown section / index / broken source", () => {
    expect(deleteMenuLink(FULL, "U", "Ops", 9)).toBeNull();
    expect(deleteMenuLink(FULL, "U", "Nope", 0)).toBeNull();
    expect(deleteMenuLink(BROKEN, "U", "Ops", 0)).toBeNull();
  });

  it("an added page link RESOLVES as a real cross-reference", async () => {
    // The builder parses link-free (no document, so `.ref` is unavailable);
    // this is the linked parse that proves the written text is a resolvable
    // `[Page:QualifiedPageName]` reference, not just parseable source.
    const out = expectParses(addMenuLink(FULL, "U", "Ops", { page: "Orders.Archive.Old" }));
    const { model, errors } = await parseString(out);
    expect(errors).toEqual([]);
    const added = [...AstUtils.streamAst(model)]
      .filter(isMenuLink)
      .find((l) => l.page?.$refText === "Orders.Archive.Old");
    expect(added?.page?.ref?.name).toBe("Old");
  });
});
