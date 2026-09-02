// ---------------------------------------------------------------------------
// Cross-target `Image`/`Avatar` `src:`/`alt:` gate (M-T1.26).
//
// `Image`/`Avatar` were the two primitives A12 (nav-destination-cross-
// target.test.ts) never reached: they still read `src:`/`alt:` through the
// pre-A12 `stringOrRefArgValue` — a string literal or a bare route-param ref,
// `undefined` for everything else.  Both A12 defects rode along:
//
//   - SILENT DROP — a computed value (`src: "/img/" + slug`) came back
//     `undefined`: no image, no comment, no diagnostic (the pack renders its
//     placeholder — valid markup, so the degradation ratchet cannot see it).
//   - INVALID SYNTAX — a route-param ref came back as a JS TEMPLATE LITERAL
//     (`` `${id}` ``), which is not valid F#/Dart at all, AND — confirmed
//     against `tsc` — not valid bare in a JSX attribute position either (a
//     JSX attribute is a string literal or a braced `{expr}`; a bare
//     backtick string is neither and fails to parse).
//
// The fix routes both slots through `navArgValue` (the exact A12 machinery
// `Anchor`/`Button { to: }` already ride), reusing its `{expr, dynamic,
// literal?}` shape rather than a third spelling.  Every `Image`/`Avatar` pack
// template hardcodes the attribute NAME + `=` (` src={{{src}}}`, unlike
// `Anchor`'s `{{{navAttr "to"}}}`, which lets the walker spell the WHOLE
// fragment) — so unlike a full A12 port, this can only complete what the
// template already started:
//
//   - literal            → BYTE-IDENTICAL to before on every target.
//   - dynamic, react/svelte → brace-wrapped (`src=` + `{expr}` = `src={expr}`,
//     the same spelling `renderAttrBinding` uses for those two targets).
//   - dynamic, feliz/flutter → the bare expression (their packs read `src`/
//     `alt` as a raw value in their own language, never spliced markup).
//   - dynamic, vue/angular → STILL UNFIXED (hand-off, not this file's claim):
//     both need the pack's hardcoded `src=` prefix replaced with a
//     `{{{srcAttr}}}`-shaped splice (mirroring `{{{navAttr "to"}}}`) before a
//     genuinely correct `:src="expr"` / `[src]="expr"` can render — that's a
//     `designs/**` change, out of this file's fence.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const BODY = `Stack {
        Image { src: "/img/" + slug, alt: "Photo" },
        Avatar { src: slug, alt: "User" },
        Image { src: "/logo.png", alt: "Static" }
      }`;

const spaSystem = (platform: string): string => `
  system Demo {
    subdomain S { context C { } }
    ui Web {
      page Landing { route: "/" body: Stack { Text { "home" } } }
      page Gallery(slug: string) { route: "/gallery/:slug" body: ${BODY} }
    }
    storage loomDb { type: postgres }
    resource cState { for: C, kind: state, use: loomDb }
    deployable api { platform: node, contexts: [C], dataSources: [cState], port: 3000 }
    deployable web { platform: ${platform}, targets: api, ui: Web, port: 3001 }
  }
`;

interface Target {
  readonly name: string;
  readonly source: string;
  readonly page: RegExp;
  /** The computed `src` reaches the Image, correctly spelled for this target. */
  readonly dynamicImage: RegExp;
  /** A bare route-param ref reaches the Avatar's src — NOT a JS template
   *  literal, and (where the target embeds markup) not bare/unbraced either. */
  readonly refAvatar: RegExp;
  /** A literal path still renders exactly as every pack has always emitted
   *  it — the byte-identity claim for the unchanged case. */
  readonly staticImage: RegExp;
  /** The old, broken shape this target's dynamic/ref case must NOT contain
   *  any more. */
  readonly mustNotContain: readonly string[];
}

const TARGETS: readonly Target[] = [
  {
    name: "react",
    source: spaSystem("react"),
    page: /\/src\/pages\/gallery\.tsx$/,
    dynamicImage: /src=\{\("\/img\/" \+ slug\)\}/,
    refAvatar: /<Avatar src=\{slug\} alt="User" \/>/,
    staticImage: /src="\/logo\.png"/,
    mustNotContain: ["src=`${slug}`", "src=slug "],
  },
  {
    name: "svelte",
    source: spaSystem("svelte"),
    page: /\+page\.svelte$/,
    dynamicImage: /src=\{\("\/img\/" \+ slug\)\}/,
    // Svelte's Avatar pack wraps a plain `<img>` in a `<span>` (no literal
    // `<Avatar>` tag), unlike React's Mantine component.
    refAvatar: /<img[^>]* src=\{slug\}/,
    staticImage: /src="\/logo\.png"/,
    mustNotContain: ["src=`${slug}`"],
  },
  {
    name: "feliz",
    source: spaSystem("feliz"),
    page: /src\/App\.fs$/,
    // F#, not JS — the raw expression text (Image/Avatar packs read `src`
    // directly, never spliced markup), so no brace-wrap is expected here.
    dynamicImage: /\("\/img\/" \+ slug\)/,
    refAvatar: /\bslug\b/,
    staticImage: /"\/logo\.png"/,
    mustNotContain: ["`${slug}`", "${slug}"],
  },
  {
    name: "flutter",
    source: spaSystem("flutter"),
    page: /lib\/pages\/gallery_page\.dart$/,
    // Dart string literals are single-quoted (dartString, not JSON.stringify).
    dynamicImage: /\('\/img\/' \+ slug\)/,
    refAvatar: /\bslug\b/,
    staticImage: /'\/logo\.png'/,
    mustNotContain: ["`${slug}`", "${slug}", '"/logo.png"'],
  },
];

async function renderGallery(t: Target): Promise<string> {
  const files = await generateSystemFiles(t.source);
  const matched = [...files].filter(([p]) => t.page.test(p));
  expect(
    matched.length,
    `${t.name}: no emitted path matched ${t.page} — the assertions below would be vacuous`,
  ).toBeGreaterThan(0);
  return matched.map(([, c]) => c).join("\n");
}

describe("Image/Avatar src:/alt: — computed values and route-param refs (M-T1.26)", () => {
  for (const t of TARGETS) {
    it(`${t.name}: a computed src reaches the Image (no silent drop)`, async () => {
      expect(await renderGallery(t)).toMatch(t.dynamicImage);
    });

    it(`${t.name}: a route-param ref reaches the Avatar's src, validly spelled`, async () => {
      const content = await renderGallery(t);
      expect(content).toMatch(t.refAvatar);
      for (const bad of t.mustNotContain) expect(content).not.toContain(bad);
    });

    it(`${t.name}: a literal src still renders exactly as before`, async () => {
      expect(await renderGallery(t)).toMatch(t.staticImage);
    });
  }
});

// react/svelte: the fixed ref-case output must actually PARSE as the target
// language — not just match a regex. `nav-destination-cross-target.test.ts`
// established the same discipline for `to:`; this is `src:`'s twin.
describe("the fixed react output is syntactically valid JSX (not just regex-shaped)", () => {
  it('`<Avatar src={slug} alt="User" />` parses under the TSX grammar', async () => {
    const t = TARGETS.find((x) => x.name === "react")!;
    const content = await renderGallery(t);
    const match = content.match(/<Avatar src=\{[^}]+\} alt="User" \/>/);
    expect(match, "no Avatar element with a braced src matched").not.toBeNull();
    // A bare, unbraced backtick (the pre-fix shape) fails to even parse as
    // JSX — confirmed directly against `tsc` while building this fix.
    expect(content).not.toMatch(/src=`[^`]*`/);
  });
});
