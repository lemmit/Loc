// Page-level property editing for the playground PAGE builder.
//
// Sibling of `state-fields-lossless.test.ts`: `page-props.ts` edits a page's
// scalar props (`route:` / `title:` / `requires` / `layout:` /
// `description:` / `ogImage:` / `canonical:`) and its `menu { … }` metadata
// block through the same narrow-CST-splice discipline, so assertions go
// through `lineDiff` (the builder's own hunk differ) to pin exactly which
// line(s) changed — a whole-page reprint would fail every one of these.

import { describe, expect, it } from "vitest";
import { lineDiff } from "../../../web/src/builder/edit-engine.js";
import {
  availableLayouts,
  pageProps,
  setPageCanonical,
  setPageDescription,
  setPageLayout,
  setPageMenuMeta,
  setPageOgImage,
  setPageRequires,
  setPageRoute,
  setPageTitle,
} from "../../../web/src/builder/page/page-props.js";
import { parseDdd } from "../../../web/src/builder/parse.js";

// A fully-decorated page: every scalar prop present, hand-aligned values, a
// `menu { }` block, and comments inside the page body that a reprint eats.
const FULL = `system S {
  layout ConsoleFrame {
    header { Text { "chrome" } }
    main
  }
  ui U {
    // the kitchen-sink page
    page Kitchen(id: Order id) {
      route:       "/kitchen"
      title:       "Kitchen sink"
      description: "Every remaining primitive on one page"
      ogImage:     "/og-kitchen.png"
      canonical:   "https://console.example.com/kitchen"
      layout:      ConsoleFrame
      requires     currentUser.permissions.contains(ops.view)
      state {
        // wizard step counter
        step: int = 0
      }
      // the body itself
      body: Text { "hi" }
      menu { section: "Ops", label: "Kitchen", order: 0 }
    }
  }
}`;

// A bare page — nested in an `area { }` (so resolution has to stream past the
// area) with nothing but a body, littered with comments.
const LEAN = `system S {
  ui U {
    area Admin {
      // grouping comment
      page Settings {
        // the body itself
        body: Text { "hi" }
      }
    }
  }
}`;

// Two `ui`s declaring the same page name — drives the `uiName` disambiguator.
const TWO_UIS = `system S {
  ui A {
    page Home {
      route: "/a"
      body: Text { "a" }
    }
  }
  ui B {
    page Home {
      route: "/b"
      body: Text { "b" }
    }
  }
}`;

// A source the parser rejects — every entry point must refuse it rather than
// splice at offsets the error-recovery parser invented.
const BROKEN = LEAN.replace("page Settings {", "page Settings {{");

const FULL_COMMENTS = ["// the kitchen-sink page", "// wizard step counter", "// the body itself"];

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

describe("page builder — page props read-back", () => {
  it("reads every scalar prop and the menu block off a decorated page", () => {
    expect(pageProps(FULL, "Kitchen")).toEqual({
      route: "/kitchen",
      title: '"Kitchen sink"',
      requiresText: "currentUser.permissions.contains(ops.view)",
      layout: "ConsoleFrame",
      description: "Every remaining primitive on one page",
      ogImage: "/og-kitchen.png",
      canonical: "https://console.example.com/kitchen",
      hasMenu: true,
      menu: { section: '"Ops"', label: '"Kitchen"', order: "0" },
    });
  });

  it("leaves absent props undefined and reports no menu block", () => {
    expect(pageProps(LEAN, "Settings")).toEqual({ hasMenu: false, menu: {} });
  });

  it("resolves a page nested in an area, and one declared with params", () => {
    expect(pageProps(LEAN, "Settings")).not.toBeNull();
    expect(pageProps(FULL, "Kitchen")?.route).toBe("/kitchen");
  });

  it("disambiguates same-named pages by ui when uiName is given", () => {
    expect(pageProps(TWO_UIS, "Home", "B")?.route).toBe("/b");
    expect(pageProps(TWO_UIS, "Home", "A")?.route).toBe("/a");
    // Without the disambiguator the first match wins, like BuilderPane's own
    // name-keyed page lookup.
    expect(pageProps(TWO_UIS, "Home")?.route).toBe("/a");
    expect(pageProps(TWO_UIS, "Home", "Nope")).toBeNull();
  });

  it("returns null on unparseable source or an unknown page", () => {
    expect(pageProps(BROKEN, "Settings")).toBeNull();
    expect(pageProps(LEAN, "Nope")).toBeNull();
  });

  it("availableLayouts lists the presets plus declared layouts", () => {
    expect(availableLayouts(parseDdd(FULL).ast)).toEqual(["default", "none", "ConsoleFrame"]);
  });
});

describe("page builder — scalar prop add / replace / remove", () => {
  it("setPageRoute adds a route line above the body", () => {
    const out = setPageRoute(LEAN, "Settings", "/settings");
    expectHunk(LEAN, out, [], ['        route: "/settings"']);
    expectCommentsIntact(out, ["// grouping comment", "// the body itself"]);
    // The body's own comment stays attached to the body — the new prop goes
    // ABOVE it, not between the comment and what it documents.
    expect(out).toContain('        route: "/settings"\n        // the body itself\n        body:');
    expect(pageProps(expectParses(out), "Settings")?.route).toBe("/settings");
  });

  it("setPageRoute replaces the value in place, preserving hand alignment", () => {
    const out = setPageRoute(FULL, "Kitchen", "/kitchen-sink");
    expectHunk(
      FULL,
      out,
      ['      route:       "/kitchen"'],
      ['      route:       "/kitchen-sink"'],
    );
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("setPageRoute(null) removes only the route line", () => {
    const out = setPageRoute(FULL, "Kitchen", null);
    expectHunk(FULL, out, ['      route:       "/kitchen"'], []);
    expect(pageProps(expectParses(out), "Kitchen")?.route).toBeUndefined();
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("setPageTitle takes expression text and lands after route", () => {
    const withRoute = setPageRoute(LEAN, "Settings", "/settings") as string;
    const out = setPageTitle(withRoute, "Settings", '"Admin " + suffix');
    expectHunk(withRoute, out, [], ['        title: "Admin " + suffix']);
    expect(pageProps(expectParses(out), "Settings")?.title).toBe('"Admin " + suffix');
  });

  it("setPageTitle rejects an expression that does not parse", () => {
    expect(setPageTitle(FULL, "Kitchen", '"x" +')).toBeNull();
  });

  it("setPageRequires adds a colon-less `requires` clause", () => {
    const out = setPageRequires(LEAN, "Settings", "currentUser.permissions.contains(ops.admin)");
    expectHunk(LEAN, out, [], ["        requires currentUser.permissions.contains(ops.admin)"]);
    expect(pageProps(expectParses(out), "Settings")?.requiresText).toBe(
      "currentUser.permissions.contains(ops.admin)",
    );
  });

  it("setPageRequires replaces the expression and re-parses clean", () => {
    const out = setPageRequires(FULL, "Kitchen", "currentUser.permissions.contains(ops.admin)");
    expectHunk(
      FULL,
      out,
      ["      requires     currentUser.permissions.contains(ops.view)"],
      ["      requires     currentUser.permissions.contains(ops.admin)"],
    );
    expectParses(out);
  });

  it("setPageRequires rejects a non-expression", () => {
    expect(setPageRequires(FULL, "Kitchen", "1 +")).toBeNull();
    expect(setPageRequires(FULL, "Kitchen", "requires")).toBeNull();
  });

  it("setPageLayout writes a bare ref and rejects a non-identifier", () => {
    const out = setPageLayout(LEAN, "Settings", "AdminFrame");
    expectHunk(LEAN, out, [], ["        layout: AdminFrame"]);
    expect(pageProps(expectParses(out), "Settings")?.layout).toBe("AdminFrame");
    expect(setPageLayout(LEAN, "Settings", '"quoted"')).toBeNull();
    expect(setPageLayout(LEAN, "Settings", "not an id")).toBeNull();
  });

  it("setPageDescription / setPageOgImage / setPageCanonical add one line each", () => {
    let src = LEAN;
    src = expectParses(setPageDescription(src, "Settings", "Admin settings"));
    src = expectParses(setPageOgImage(src, "Settings", "/og-admin.png"));
    src = expectParses(setPageCanonical(src, "Settings", "https://example.com/settings"));
    expectHunk(
      LEAN,
      src,
      [],
      [
        '        description: "Admin settings"',
        '        ogImage: "/og-admin.png"',
        '        canonical: "https://example.com/settings"',
      ],
    );
    const info = pageProps(src, "Settings");
    expect([info?.description, info?.ogImage, info?.canonical]).toEqual([
      "Admin settings",
      "/og-admin.png",
      "https://example.com/settings",
    ]);
  });

  it("inserts scalar props in canonical order however they are added", () => {
    let src = LEAN;
    src = expectParses(setPageCanonical(src, "Settings", "https://example.com/settings"));
    src = expectParses(setPageRoute(src, "Settings", "/settings"));
    src = expectParses(setPageLayout(src, "Settings", "AdminFrame"));
    src = expectParses(setPageTitle(src, "Settings", '"Settings"'));
    expectHunk(
      LEAN,
      src,
      [],
      [
        '        route: "/settings"',
        '        title: "Settings"',
        '        canonical: "https://example.com/settings"',
        "        layout: AdminFrame",
      ],
    );
    // The body (and its comment) still trails the whole group.
    expectCommentsIntact(src, ["// grouping comment", "// the body itself"]);
  });

  it("escapes quotes when writing a string-valued prop", () => {
    const out = expectParses(setPageDescription(LEAN, "Settings", 'He said "hi"'));
    expect(pageProps(out, "Settings")?.description).toBe('He said "hi"');
  });

  it("removing an absent prop is a no-op returning the source unchanged", () => {
    expect(setPageLayout(LEAN, "Settings", null)).toBe(LEAN);
    expect(setPageRoute(LEAN, "Settings", null)).toBe(LEAN);
  });

  it("empty text removes the prop, like clearing the input", () => {
    const out = setPageTitle(FULL, "Kitchen", "  ");
    expectHunk(FULL, out, ['      title:       "Kitchen sink"'], []);
  });

  it("returns null on a source with parser errors", () => {
    expect(setPageRoute(BROKEN, "Settings", "/x")).toBeNull();
    expect(setPageTitle(BROKEN, "Settings", '"x"')).toBeNull();
    expect(setPageRequires(BROKEN, "Settings", "a.b")).toBeNull();
    expect(setPageLayout(BROKEN, "Settings", "X")).toBeNull();
    expect(setPageDescription(BROKEN, "Settings", "x")).toBeNull();
    expect(setPageOgImage(BROKEN, "Settings", "x")).toBeNull();
    expect(setPageCanonical(BROKEN, "Settings", "x")).toBeNull();
  });

  it("returns null for an unknown page", () => {
    expect(setPageRoute(LEAN, "Nope", "/x")).toBeNull();
    expect(setPageMenuMeta(LEAN, "Nope", "label", '"x"')).toBeNull();
  });
});

describe("page builder — menu metadata block", () => {
  it("creates the block on the first set, after the body", () => {
    const out = setPageMenuMeta(LEAN, "Settings", "section", '"Admin"');
    expectHunk(LEAN, out, [], ['        menu { section: "Admin" }']);
    expect(pageProps(expectParses(out), "Settings")).toMatchObject({
      hasMenu: true,
      menu: { section: '"Admin"' },
    });
  });

  it("appends a second entry to the existing single-line block", () => {
    const first = expectParses(setPageMenuMeta(LEAN, "Settings", "section", '"Admin"'));
    const out = setPageMenuMeta(first, "Settings", "order", "3");
    expectHunk(
      first,
      out,
      ['        menu { section: "Admin" }'],
      ['        menu { section: "Admin", order: 3 }'],
    );
    expect(pageProps(expectParses(out), "Settings")?.menu).toEqual({
      section: '"Admin"',
      order: "3",
    });
  });

  it("replaces an existing entry's value in place", () => {
    const out = setPageMenuMeta(FULL, "Kitchen", "label", '"Kitchen sink"');
    expectHunk(
      FULL,
      out,
      ['      menu { section: "Ops", label: "Kitchen", order: 0 }'],
      ['      menu { section: "Ops", label: "Kitchen sink", order: 0 }'],
    );
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("removes a middle entry with its separator", () => {
    const out = setPageMenuMeta(FULL, "Kitchen", "label", null);
    expectHunk(
      FULL,
      out,
      ['      menu { section: "Ops", label: "Kitchen", order: 0 }'],
      ['      menu { section: "Ops", order: 0 }'],
    );
    expect(pageProps(expectParses(out), "Kitchen")?.menu).toEqual({ section: '"Ops"', order: "0" });
  });

  it("removes the first entry with its separator", () => {
    const out = setPageMenuMeta(FULL, "Kitchen", "section", null);
    expectHunk(
      FULL,
      out,
      ['      menu { section: "Ops", label: "Kitchen", order: 0 }'],
      ['      menu { label: "Kitchen", order: 0 }'],
    );
    expectParses(out);
  });

  it("drops the whole block when its last entry is removed", () => {
    let src: string = FULL;
    src = expectParses(setPageMenuMeta(src, "Kitchen", "section", null));
    src = expectParses(setPageMenuMeta(src, "Kitchen", "label", null));
    const out = setPageMenuMeta(src, "Kitchen", "order", null);
    expectHunk(src, out, ["      menu { order: 0 }"], []);
    expect(pageProps(expectParses(out), "Kitchen")).toMatchObject({ hasMenu: false, menu: {} });
    expectCommentsIntact(out, FULL_COMMENTS);
  });

  it("supports boolean and numeric entry values", () => {
    const out = expectParses(setPageMenuMeta(FULL, "Kitchen", "hidden", "true"));
    expect(pageProps(out, "Kitchen")?.menu.hidden).toBe("true");
    const bumped = expectParses(setPageMenuMeta(out, "Kitchen", "order", "12"));
    expect(pageProps(bumped, "Kitchen")?.menu.order).toBe("12");
  });

  it("keeps a multi-line block one entry per line", () => {
    const MULTI = FULL.replace(
      '      menu { section: "Ops", label: "Kitchen", order: 0 }',
      ["      menu {", '        section: "Ops",', '        label: "Kitchen"', "      }"].join("\n"),
    );
    const out = setPageMenuMeta(MULTI, "Kitchen", "order", "7");
    expectHunk(
      MULTI,
      out,
      ['        label: "Kitchen"'],
      ['        label: "Kitchen",', "        order: 7"],
    );
    expect(pageProps(expectParses(out), "Kitchen")?.menu.order).toBe("7");
  });

  it("rejects an entry value that is not an expression", () => {
    expect(setPageMenuMeta(FULL, "Kitchen", "order", "1 +")).toBeNull();
  });

  it("removing an absent entry is a no-op returning the source unchanged", () => {
    expect(setPageMenuMeta(FULL, "Kitchen", "hidden", null)).toBe(FULL);
    expect(setPageMenuMeta(LEAN, "Settings", "hidden", null)).toBe(LEAN);
  });

  it("returns null on a source with parser errors", () => {
    expect(setPageMenuMeta(BROKEN, "Settings", "section", '"x"')).toBeNull();
  });
});
