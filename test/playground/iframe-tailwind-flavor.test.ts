import { describe, expect, it } from "vitest";

import { makePreviewHtml } from "../../web/src/preview/iframe-html.js";

// The playground bundles in-browser (esbuild-wasm), so Tailwind-
// authored CSS is compiled at iframe load time by an in-browser
// JIT, not at build time.  Two dialects:
//   - shadcn@v3 → `@tailwind base; …` → Tailwind 3 Play CDN +
//     inlined `window.tailwind.config`.
//   - shadcn@v4 → `@import "tailwindcss";` (+ `@theme` inline) →
//     `@tailwindcss/browser` (no JS config object).
// Mantine ships pre-compiled CSS → plain `<style>`, no JIT script.
//
// Regression guard for the shadcn@v4 promote: without the v4 branch
// the bareword default would ship unstyled previews.

const V3_CSS = `@tailwind base;
@tailwind components;
@tailwind utilities;

:root { --radius: 0.5rem; }`;

const V4_CSS = `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

:root { --radius: 0.5rem; }

@theme inline {
  --color-primary: hsl(var(--primary));
}`;

const MANTINE_CSS = `.m_abc { color: red; }`;

describe("iframe-html — Tailwind v3 path (shadcn@v3)", () => {
  const html = makePreviewHtml({ js: "/* b */", css: V3_CSS });

  it("loads the Tailwind 3 Play CDN with an inlined config", () => {
    expect(html).toContain('<script src="https://cdn.tailwindcss.com"></script>');
    expect(html).toMatch(/tailwind\.config\s*=/);
  });

  it("routes the CSS through the JIT style block", () => {
    expect(html).toContain('<style id="loom-css" type="text/tailwindcss">');
  });

  it("does not pull the v4 browser runtime", () => {
    expect(html).not.toContain("@tailwindcss/browser");
  });
});

describe("iframe-html — Tailwind v4 path (shadcn@v4)", () => {
  const html = makePreviewHtml({ js: "/* b */", css: V4_CSS });

  it("loads @tailwindcss/browser (the v4 in-browser compiler)", () => {
    expect(html).toContain("@tailwindcss/browser@4");
  });

  it("does not inline a v3 `tailwind.config` or load the v3 Play CDN", () => {
    // The CSP `script-src` allowlists the CDN domain; what matters is
    // that the v3 Play CDN `<script>` itself isn't injected.
    expect(html).not.toContain('src="https://cdn.tailwindcss.com"');
    expect(html).not.toMatch(/tailwind\.config\s*=/);
  });

  it('keeps `@import "tailwindcss"` for the browser runtime to resolve', () => {
    expect(html).toContain('@import "tailwindcss"');
  });

  it('strips the unresolvable `@import "tw-animate-css"`', () => {
    // `@tailwindcss/browser` can't fetch the bare third-party
    // specifier — leaving it in errors the whole compile.
    expect(html).not.toContain("tw-animate-css");
  });

  it("routes the CSS through the JIT style block", () => {
    expect(html).toContain('<style id="loom-css" type="text/tailwindcss">');
  });
});

describe("iframe-html — non-Tailwind CSS (Mantine)", () => {
  const html = makePreviewHtml({ js: "/* b */", css: MANTINE_CSS });

  it("uses a plain <style> tag and no JIT script", () => {
    expect(html).toContain('<style id="loom-css">');
    expect(html).not.toContain('type="text/tailwindcss"');
    // CSP `script-src` names the CDN domain; assert no CDN `<script>` loads.
    expect(html).not.toContain('src="https://cdn.tailwindcss.com"');
    expect(html).not.toContain("@tailwindcss/browser");
  });
});
