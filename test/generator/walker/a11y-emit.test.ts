import { describe, expect, it } from "vitest";
import { escapeHtmlAttr, iconA11yAttr } from "../../../src/generator/_walker/a11y-emit.js";

describe("a11y-emit — iconA11yAttr", () => {
  it("hides an unlabelled icon (decorative-by-default)", () => {
    expect(iconA11yAttr({})).toBe(' aria-hidden="true"');
    expect(iconA11yAttr({ label: "" })).toBe(' aria-hidden="true"');
  });

  it("names a labelled icon as an img", () => {
    expect(iconA11yAttr({ label: "Search" })).toBe(' role="img" aria-label="Search"');
  });

  it("decorative: true forces hidden even alongside a label", () => {
    expect(iconA11yAttr({ label: "Search", decorative: true })).toBe(' aria-hidden="true"');
  });

  it("escapes the label for a double-quoted attribute", () => {
    expect(iconA11yAttr({ label: `a "b" & <c>` })).toBe(
      ' role="img" aria-label="a &quot;b&quot; &amp; &lt;c&gt;"',
    );
  });
});

describe("a11y-emit — escapeHtmlAttr", () => {
  it("escapes the four attribute-breaking characters", () => {
    expect(escapeHtmlAttr(`& " < >`)).toBe("&amp; &quot; &lt; &gt;");
  });
});
