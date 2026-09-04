// Sidebar nav LABEL tokens — `src/generator/_frontend/nav-labels.ts` (M-T1.11,
// audit finding A13b).
//
// An authored `menu { section "Sales" { link Orders { label: "All orders" } } }`
// has always contributed `menu.section.<hash>` / `menu.link.<hash>` entries to
// the message catalog, and nothing ever rendered them: the emitter handed the
// shells a RAW string and all 15 pack templates spelled it `{{label}}`, so a
// translator translated text the app showed in English at every locale.
//
// The fix is at the VIEW-MODEL layer — each nav entry arrives at the template
// ALREADY SPELLED for its target — so what has to be pinned is:
//
//   * the three per-framework spellings, in both markup positions;
//   * the two fall-through paths (i18n off, or a label with no catalog key)
//     producing the Handlebars-ESCAPED raw string — byte-for-byte what the old
//     `{{label}}` double-stache produced, which is why `escapeExpression` is
//     reused here rather than a hand-rolled escape;
//   * `withNavLabelTokens` decorating sections AND their entries, purely.

import Handlebars from "handlebars";
import { describe, expect, it } from "vitest";
import {
  ANGULAR_NAV_LABELS,
  JSX_NAV_LABELS,
  type NavLabelSpelling,
  VUE_NAV_LABELS,
  withNavLabelTokens,
} from "../../../src/generator/_frontend/nav-labels.js";

const KEY = "menu.link.a4kmad";
const MSG = "All orders";
// The emitted call is `t(key, message)` with BOTH arguments JSON-quoted, so the
// generated default text and the catalog entry cannot drift.
const CALL = `t("${KEY}", "${MSG}")`;

interface Entry {
  label: string;
  labelKey?: string;
  to: string;
}
interface Section {
  label: string;
  labelKey?: string;
  entries: Entry[];
}

const sections = (spelling?: NavLabelSpelling) =>
  withNavLabelTokens<Entry, Section>(
    [
      {
        label: "Sales",
        labelKey: "menu.section.mlh3jc",
        entries: [
          { label: MSG, labelKey: KEY, to: "/orders" },
          // An emitter-DERIVED label (the default aggregate sidebar): no key,
          // so no translator ever sees it and no `t()` may be emitted for it.
          { label: "Customers", to: "/customers" },
        ],
      },
    ],
    spelling,
  );

describe("the three per-framework spellings", () => {
  it("JSX (React + Svelte) — single braces in text, `attr={…}` in attribute position", () => {
    expect(JSX_NAV_LABELS.text(KEY, MSG)).toBe(`{${CALL}}`);
    expect(JSX_NAV_LABELS.attr("label", KEY, MSG)).toBe(`label={${CALL}}`);
  });

  it("Vue — a mustache in text, a single-quoted `:attr` binding in attribute position", () => {
    expect(VUE_NAV_LABELS.text(KEY, MSG)).toBe(`{{ ${CALL} }}`);
    // Single quotes because the `t()` call itself carries double quotes.
    expect(VUE_NAV_LABELS.attr("label", KEY, MSG)).toBe(`:label='${CALL}'`);
    expect(VUE_NAV_LABELS.attr("label", KEY, MSG)).not.toContain(`"${CALL}"`);
  });

  it("Angular — the same mustache, and a `[attr]` property binding", () => {
    expect(ANGULAR_NAV_LABELS.text(KEY, MSG)).toBe(`{{ ${CALL} }}`);
    expect(ANGULAR_NAV_LABELS.attr("label", KEY, MSG)).toBe(`[label]='${CALL}'`);
  });

  it("emits no leading space on the attribute fragment (the template owns spacing)", () => {
    for (const s of [JSX_NAV_LABELS, VUE_NAV_LABELS, ANGULAR_NAV_LABELS]) {
      expect(s.attr("aria-label", KEY, MSG)).toBe(s.attr("aria-label", KEY, MSG).trimStart());
    }
  });
});

describe("withNavLabelTokens — decorating a sidebar under each spelling", () => {
  it("spells a KEYED label through the target's `t()` call", () => {
    const [jsx] = sections(JSX_NAV_LABELS);
    expect(jsx?.entries[0]?.labelText).toBe(`{${CALL}}`);
    expect(jsx?.entries[0]?.labelAttr("label")).toBe(`label={${CALL}}`);

    const [vue] = sections(VUE_NAV_LABELS);
    expect(vue?.entries[0]?.labelText).toBe(`{{ ${CALL} }}`);
    expect(vue?.entries[0]?.labelAttr("label")).toBe(`:label='${CALL}'`);

    const [ng] = sections(ANGULAR_NAV_LABELS);
    expect(ng?.entries[0]?.labelText).toBe(`{{ ${CALL} }}`);
    expect(ng?.entries[0]?.labelAttr("label")).toBe(`[label]='${CALL}'`);
  });

  it("decorates the SECTION heading too, with its own key", () => {
    const [jsx] = sections(JSX_NAV_LABELS);
    expect(jsx?.labelText).toBe(`{t("menu.section.mlh3jc", "Sales")}`);
    expect(jsx?.labelAttr("title")).toBe(`title={t("menu.section.mlh3jc", "Sales")}`);
  });

  it("falls back to the ESCAPED raw string with i18n off — byte-identical to `{{label}}`", () => {
    const [off] = sections(undefined);
    expect(off?.labelText).toBe("Sales");
    expect(off?.entries[0]?.labelText).toBe(MSG);
    expect(off?.entries[0]?.labelAttr("label")).toBe(`label="${MSG}"`);
  });

  it("falls back for a KEYLESS label even when i18n is on (no dead keys)", () => {
    for (const spelling of [JSX_NAV_LABELS, VUE_NAV_LABELS, ANGULAR_NAV_LABELS]) {
      const [s] = sections(spelling);
      // "Customers" is emitter-derived: not in the catalog, so emitting a
      // `t()` for it would resolve to nothing at runtime.
      expect(s?.entries[1]?.labelText).toBe("Customers");
      expect(s?.entries[1]?.labelAttr("label")).toBe(`label="Customers"`);
    }
  });

  it("escapes exactly as Handlebars would in the fallback", () => {
    const raw = `Tom & "Jerry" <b> it's`;
    const [s] = withNavLabelTokens<Entry, Section>(
      [{ label: raw, entries: [{ label: raw, to: "/x" }] }],
      JSX_NAV_LABELS,
    );
    expect(s?.labelText).toBe(Handlebars.escapeExpression(raw));
    expect(s?.labelText).toBe("Tom &amp; &quot;Jerry&quot; &lt;b&gt; it&#x27;s");
    // The attribute value is the same escaped text — the `"` inside it is
    // already `&quot;`, so the emitted attribute stays well-formed.
    expect(s?.entries[0]?.labelAttr("label")).toBe(`label="${Handlebars.escapeExpression(raw)}"`);
  });

  it("stringifies whatever the pack passes as the attribute name", () => {
    const [s] = sections(JSX_NAV_LABELS);
    // `{{{labelAttr "aria-label"}}}` — Handlebars hands the helper an unknown,
    // so the token has to accept one.
    expect(s?.entries[0]?.labelAttr("aria-label")).toBe(`aria-label={${CALL}}`);
    const [off] = sections(undefined);
    expect(off?.entries[0]?.labelAttr("aria-label")).toBe(`aria-label="${MSG}"`);
  });

  it("is pure — the input view-models are left untouched", () => {
    const input: Section[] = [
      { label: "Sales", labelKey: "menu.section.mlh3jc", entries: [{ label: MSG, to: "/orders" }] },
    ];
    const before = JSON.stringify(input);
    const out = withNavLabelTokens<Entry, Section>(input, JSX_NAV_LABELS);
    expect(JSON.stringify(input)).toBe(before);
    expect(out[0]).not.toBe(input[0]);
    expect(out[0]?.entries[0]).not.toBe(input[0]?.entries[0]);
    // The original fields survive the decoration.
    expect(out[0]?.entries[0]?.to).toBe("/orders");
    expect(out[0]?.label).toBe("Sales");
  });

  it("puts a token on EVERY section and entry, so a strict template never sees a hole", () => {
    for (const spelling of [undefined, JSX_NAV_LABELS, VUE_NAV_LABELS, ANGULAR_NAV_LABELS]) {
      for (const section of sections(spelling)) {
        expect(typeof section.labelText).toBe("string");
        expect(typeof section.labelAttr).toBe("function");
        for (const entry of section.entries) {
          expect(typeof entry.labelText).toBe("string");
          expect(typeof entry.labelAttr).toBe("function");
        }
      }
    }
  });
});
