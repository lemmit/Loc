import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Drift guard: the playground's iframe-html.ts injects a Tailwind
// Play CDN config that mirrors the shadcn pack's tailwind.config.ts
// (designs/shadcn/tailwind-config.hbs).  These two literals must agree
// on the design tokens (`extend.colors`, `extend.borderRadius`,
// `container`) — otherwise a class that resolves cleanly in the
// generated `npm run dev` build silently fails to apply in the
// playground preview, so the iframe paints with shadcn HTML but no
// (or wrong) colors.
//
// The hbs template ships extra TS-only bits the Play CDN can't run
// (the `tailwindcss-animate` plugin and its `keyframes` /
// `animation`).  Those legitimately diverge — we only assert
// equality on the design-token surface.
//
// Long-term fix: extract the theme tokens to a JSON file shared by
// both consumers (the generated tailwind.config.ts imports it; the
// iframe's vite bundle inlines it).  That requires extending the
// pack contract to support non-Handlebars asset passthroughs;
// captured as follow-up.  Until then, this test catches the drift
// at source.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

/** Extract a top-level object-literal block by anchor key.  Returns
 *  the body between the opening `{` after the key and its matching
 *  `}` — minus whitespace, so we can compare structure not formatting.
 *  Brace-counting handles nested objects (e.g. `colors: { primary:
 *  { DEFAULT: ... } }`). */
function extractBlock(src: string, anchor: RegExp): string {
  const m = anchor.exec(src);
  if (!m) throw new Error(`no match for anchor ${anchor}`);
  // Find the next `{` after the matched anchor (handles `key:` followed
  // by optional whitespace and a brace).
  const openIdx = src.indexOf("{", m.index + m[0].length - 1);
  if (openIdx < 0) throw new Error(`no opening brace after ${anchor}`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return src.slice(openIdx + 1, i).replace(/\s+/g, "");
      }
    }
  }
  throw new Error(`unbalanced braces after ${anchor}`);
}

describe("iframe TAILWIND_PLAY_CONFIG ↔ shadcn pack tailwind-config drift guard", () => {
  const hbs = fs.readFileSync(
    path.join(repoRoot, "designs/shadcn/v3/tailwind-config.hbs"),
    "utf-8",
  );
  const iframe = fs.readFileSync(path.join(repoRoot, "web/src/preview/iframe-html.ts"), "utf-8");

  it.each([
    ["container", /\bcontainer:\s*/],
    ["extend.colors", /\bcolors:\s*/],
    ["extend.borderRadius", /\bborderRadius:\s*/],
  ] as const)("agree on `%s` block", (_, anchor) => {
    const fromHbs = extractBlock(hbs, anchor);
    const fromIframe = extractBlock(iframe, anchor);
    expect(fromIframe).toBe(fromHbs);
  });
});
