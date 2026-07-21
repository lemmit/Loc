import { describe, expect, it } from "vitest";
import { svelteTarget } from "../../../src/generator/svelte/walker/svelte-target.js";

// Regression (docs/audits/repo-code-review-2026-07.md F2): the Svelte
// `renderStyleAttr` seam interpolated a DYNAMIC value inside a quoted
// `style="…"` and then entity-escaped every `"` in the whole string.  A dynamic
// value is `JSON.stringify`-rendered, so it carries double quotes
// (`active ? "green" : "gray"`) — the escape turned those into `&quot;` INSIDE
// the `{…}` JS expression, which Svelte parses as JS and rejects (compile
// break).  An all-static style stays a plain quoted attribute.

describe("svelte renderStyleAttr — dynamic values", () => {
  it("binds a template literal for a dynamic value (no &quot; corruption)", () => {
    const out = svelteTarget.renderStyleAttr([
      { key: "color", rendered: '(active ? "green" : "gray")' },
    ]);
    // A JS template-literal binding — the `${…}` has no attribute delimiter to
    // collide with, so the inner double quotes survive intact.
    expect(out).toBe(' style={`color: ${(active ? "green" : "gray")}`}');
    expect(out).not.toContain("&quot;");
  });

  it("mixes literal + dynamic entries in one template-literal binding", () => {
    const out = svelteTarget.renderStyleAttr([
      { key: "padding", literal: "8px", rendered: '"8px"' },
      { key: "color", rendered: "c" },
    ]);
    expect(out).toBe(" style={`padding: 8px; color: ${c}`}");
  });

  it("keeps an all-static style as a plain quoted attribute (byte-identical)", () => {
    const out = svelteTarget.renderStyleAttr([
      { key: "background", literal: "red", rendered: '"red"' },
      { key: "gap", literal: "16px", rendered: '"16px"' },
    ]);
    expect(out).toBe(' style="background: red; gap: 16px"');
  });
});
