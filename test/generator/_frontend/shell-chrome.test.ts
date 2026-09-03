// ---------------------------------------------------------------------------
// `_frontend/shell-chrome.ts` — the six app-shell chrome BINDING FORMS
// (jsx / vue / angular × text / attribute), each with an i18n-on and an
// i18n-off spelling.
//
// Already pinned elsewhere, deliberately not repeated here:
//   * `test/generator/pack-chrome-i18n.test.ts` — that each of the eleven
//     shell-rendering packs actually routes its 404 / skip link / nav aria /
//     error boundary through one of these tokens, and that the i18n-off output
//     stays byte-identical raw text.  That file exercises the helpers through
//     eleven whole system generations; it never calls them.
//
// What is NOT pinned there, and is the subject here: the helpers' own contract.
// Three properties the generated shells depend on and no generation-level test
// isolates —
//
//   (1) THE ENGLISH DEFAULT IS THE CATALOG'S.  `entry()` reads
//       `APP_SHELL_CHROME`, so the emitted `t(key, default)` fallback equals the
//       merged catalog entry.  A helper that re-typed the English by hand would
//       ship a `t()` whose fallback differs from what translators were given —
//       invisible until someone diffs two strings that are both "correct".
//   (2) I18N-OFF EMITS NO `t(`.  The whole reason the pair exists is the
//       byte-identical guarantee for an app that opted out.
//   (3) AN UNKNOWN NAME THROWS.  A typo'd chrome name must be a generation-time
//       error, not `t("chrome.tyop", undefined)` rendering the literal word
//       "undefined" into a shell.
//
// Plus the quoting rule the two ATTRIBUTE forms differ on: the `t()` call holds
// double quotes, so Vue/Angular bind it inside SINGLE quotes while the JSX form
// uses braces.  Getting that backwards produces a template that parses and a
// value that does not.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  angularChromeAttr,
  angularChromeText,
  jsxChromeAttr,
  jsxChromeText,
  vueChromeAttr,
  vueChromeText,
} from "../../../src/generator/_frontend/shell-chrome.js";
import { APP_SHELL_CHROME, chromeKey } from "../../../src/generator/_walker/i18n-chrome.js";

/** Every chrome name the shell helpers may be asked for — derived from the
 *  catalog, so a new `APP_SHELL_CHROME` entry is covered without editing this
 *  file (and a REMOVED one can't leave a stale hardcoded name behind). */
const NAMES = Object.keys(APP_SHELL_CHROME).map((k) => k.replace(/^chrome\./, ""));

type TextForm = (name: string, i18nEnabled: boolean) => string;
type AttrForm = (attr: string, name: string, i18nEnabled: boolean) => string;

const TEXT: ReadonlyArray<[string, TextForm]> = [
  ["jsx", jsxChromeText],
  ["vue", vueChromeText],
  ["angular", angularChromeText],
];

const ATTR: ReadonlyArray<[string, AttrForm]> = [
  ["jsx", jsxChromeAttr],
  ["vue", vueChromeAttr],
  ["angular", angularChromeAttr],
];

describe("shell chrome — the i18n-ON spelling carries the catalog's own key + English", () => {
  it.each(TEXT)("%s text position", (_id, form) => {
    expect(NAMES.length).toBeGreaterThan(5);
    for (const name of NAMES) {
      const out = form(name, true);
      // The exact `t(key, default)` call, with BOTH halves read off the
      // catalog — this is (1), and it is what makes the emitted fallback and
      // the merged catalog entry the same string by construction.
      expect(out).toContain(
        `t(${JSON.stringify(chromeKey(name))}, ${JSON.stringify(APP_SHELL_CHROME[chromeKey(name)])})`,
      );
    }
  });

  it.each(ATTR)("%s attribute position", (_id, form) => {
    for (const name of NAMES) {
      const out = form("aria-label", name, true);
      expect(out).toContain(
        `t(${JSON.stringify(chromeKey(name))}, ${JSON.stringify(APP_SHELL_CHROME[chromeKey(name)])})`,
      );
      // No leading space — the surrounding template owns the whitespace, so a
      // helper that added one would double it in every shell.
      expect(out).toBe(out.trimStart());
    }
  });
});

describe("shell chrome — the i18n-OFF spelling is the raw English, with no t( at all", () => {
  it.each(TEXT)("%s text position", (_id, form) => {
    for (const name of NAMES) {
      expect(form(name, false)).toBe(APP_SHELL_CHROME[chromeKey(name)]);
      expect(form(name, false)).not.toContain("t(");
    }
  });

  it.each(ATTR)("%s attribute position", (_id, form) => {
    for (const name of NAMES) {
      const out = form("aria-label", name, false);
      // Identical across all three frameworks: a plain static HTML attribute.
      expect(out).toBe(`aria-label="${APP_SHELL_CHROME[chromeKey(name)]}"`);
      expect(out).not.toContain("t(");
    }
  });
});

describe("shell chrome — the framework wrappers each frontend's template needs", () => {
  it("jsx interpolates with single braces (React and Svelte share this form)", () => {
    expect(jsxChromeText("notFound", true)).toBe('{t("chrome.notFound", "Not found")}');
    expect(jsxChromeAttr("aria-label", "primaryNav", true)).toBe(
      'aria-label={t("chrome.primaryNav", "Primary navigation")}',
    );
  });

  it("vue interpolates with a mustache and binds attributes with `:`", () => {
    expect(vueChromeText("notFound", true)).toBe('{{ t("chrome.notFound", "Not found") }}');
    expect(vueChromeAttr("title", "somethingWentWrong", true)).toBe(
      `:title='t("chrome.somethingWentWrong", "Something went wrong")'`,
    );
  });

  it("angular shares the mustache but binds attributes through [attr.x]", () => {
    expect(angularChromeText("notFound", true)).toBe('{{ t("chrome.notFound", "Not found") }}');
    expect(angularChromeAttr("aria-label", "primaryNav", true)).toBe(
      `[attr.aria-label]='t("chrome.primaryNav", "Primary navigation")'`,
    );
  });

  it("the bound-attribute forms quote with ' — the t() call already holds \"", () => {
    // A double-quoted binding would terminate at the key's opening quote:
    // `:title="t("chrome…` is a template that parses to garbage.  Stated as a
    // property over every name, not one example.
    for (const name of NAMES) {
      for (const form of [vueChromeAttr, angularChromeAttr]) {
        const out = form("aria-label", name, true);
        expect(out.endsWith("'")).toBe(true);
        expect(out).toContain("='t(");
      }
      expect(jsxChromeAttr("aria-label", name, true)).toContain("={t(");
    }
  });
});

describe("shell chrome — an unknown name is a generation-time error", () => {
  // Otherwise the shell ships `t("chrome.tyop", undefined)`, which the runtime
  // renders as the literal string "undefined".
  it.each([
    ["jsxChromeText", () => jsxChromeText("tyop", true)],
    ["jsxChromeAttr", () => jsxChromeAttr("aria-label", "tyop", true)],
    ["vueChromeText", () => vueChromeText("tyop", true)],
    ["vueChromeAttr", () => vueChromeAttr("aria-label", "tyop", true)],
    ["angularChromeText", () => angularChromeText("tyop", true)],
    ["angularChromeAttr", () => angularChromeAttr("aria-label", "tyop", true)],
  ])("%s throws", (_id, call) => {
    expect(call).toThrow(/unknown app-shell chrome/);
  });

  it("throws on the i18n-OFF path too — the raw branch reads the same table", () => {
    // The off path is where a typo would otherwise be silent: it emits the
    // English directly, so an unknown name would inline `undefined` as TEXT.
    expect(() => jsxChromeText("tyop", false)).toThrow(/unknown app-shell chrome/);
    expect(() => vueChromeAttr("aria-label", "tyop", false)).toThrow(/unknown app-shell chrome/);
  });

  it("a PRIMITIVE chrome name is not an app-shell name (the tables are separate)", () => {
    // `chrome.loading` lives in `CHROME_MESSAGES`, contributed used-only off a
    // `Loader()` call — asking the SHELL helpers for it is the same mistake as
    // a typo, and must fail the same way rather than silently binding a key the
    // shell's merge gate never writes.
    expect(APP_SHELL_CHROME[chromeKey("loading")]).toBeUndefined();
    expect(() => jsxChromeText("loading", true)).toThrow(/unknown app-shell chrome/);
  });
});
