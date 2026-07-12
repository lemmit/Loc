import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// accessibility.md — a user `theme {}` colour whose fill shade leaves no
// readable standard text colour (neither white nor near-black clears WCAG-AA)
// can't produce a conformant app.  `loom.a11y-theme-contrast` warns at compile
// time — the compile-time twin of the per-pack token-contrast gate, extended to
// the author's own colour overrides (which the gate over the default palette
// can't see).  A WARNING, not an error: the pack picks the text colour, so it's
// advisory, but the footgun is surfaced without waiting for the nightly axe run.

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
  };
}

const sys = (themeProps: string) => `
system S {
  theme { ${themeProps} }
  subdomain M { context C { } }
  ui WebApp { page P { route: "/p" body: Heading { "x" } } }
  deployable api { platform: node, contexts: [C], port: 3000 }
  deployable web { platform: static, targets: api, ui: WebApp, port: 3001, design: "mantine" }
}
`;

const lowContrast = (warns: string[]) =>
  warns.some((w) => /no readable text|a11y-theme-contrast|WCAG-AA/.test(w));

describe("a11y — theme colour contrast (loom.a11y-theme-contrast)", () => {
  it("warns on a mid-tone brand colour with no readable text (#7a7a7a → 4.29:1)", async () => {
    const { warnings } = await parse(sys(`primary: "#7a7a7a"`));
    expect(lowContrast(warnings)).toBe(true);
  });

  it("warns per-role — a semantic colour is checked too", async () => {
    const { warnings } = await parse(sys(`success: "#7d7d7d"`));
    expect(lowContrast(warnings)).toBe(true);
  });

  it("accepts a readable brand colour (the indigo default, 6.29:1)", async () => {
    const { warnings } = await parse(sys(`primary: "#4f46e5"`));
    expect(lowContrast(warnings)).toBe(false);
  });

  it("accepts a common saturated colour readable at the chosen shade (#e11d48)", async () => {
    // Fails only at Loom's derived lighter shade (dark mode), not the author's
    // literal colour — the validator scopes to the chosen fill, so no warning.
    const { warnings } = await parse(sys(`error: "#e11d48"`));
    expect(lowContrast(warnings)).toBe(false);
  });

  it("skips non-hex colour values (a CSS name / var can't be evaluated)", async () => {
    const { warnings } = await parse(sys(`primary: "rebeccapurple"`));
    expect(lowContrast(warnings)).toBe(false);
  });

  it("ignores non-colour theme props (radius / fontFamily)", async () => {
    const { warnings, errors } = await parse(sys(`radius: "lg"  fontFamily: "Inter"`));
    expect(lowContrast(warnings)).toBe(false);
    expect(errors).toEqual([]);
  });

  it("never escalates past a warning", async () => {
    const { errors } = await parse(sys(`primary: "#7a7a7a"`));
    expect(errors.some((e) => /theme|contrast/i.test(e))).toBe(false);
  });
});
