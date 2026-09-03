// ---------------------------------------------------------------------------
// The CROSS-PACK gate for the spacing and chrome contract (M-FT.21).
//
// One fixture — the same primitive call, the same context — rendered through
// EVERY React/Vue/Svelte/Angular pack, with each pack's own spelling resolved
// back to pixels and compared against `SPACING_CONTRACT`.
//
// WHY IT RESOLVES RATHER THAN MATCHES
// -----------------------------------
// A string test ("the mantine stack says gap=md") pins a spelling, not a
// distance, and the whole defect class this gate exists for was packs that
// agreed on the SPELLING and disagreed on the DISTANCE: mui and chakra both
// wrote `gap={1}`, which is 8px on MUI's 8px unit and 4px on Chakra's 4px
// token scale.  So each dialect gets a resolver, verified against the
// installed libraries' own scales, and the assertion is in pixels.
//
// WHY IT REFUSES AN UNSTATED GAP
// ------------------------------
// A pack that says nothing and inherits `Stack`'s library default is not
// conformant even when the default happens to match: that is how four packs
// drifted apart in the first place, and a library upgrade moves it again with
// no diff to review.  `resolve()` returning `null` — nothing stated — is a
// failure, not a pass.
//
// KNOWN_DEVIATIONS is a RATCHET, not an excuse list: each entry asserts the
// pack STILL deviates, so the mission that fixes the pack must delete its
// entry in the same PR (CLAUDE.md's waiver rule).
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPack } from "../../../src/generator/_packs/loader-fs.js";
import {
  rulePx,
  SPACING_CONTRACT,
  SPACING_SCALE,
  SPACING_TOLERANCE_PX,
  type SpacingConcern,
} from "../../../src/generator/_packs/spacing-contract.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");
const designs = path.join(repoRoot, "designs");

// ---------------------------------------------------------------------------
// Dialects — how a pack spells a distance, and what that spelling is worth.
// Each unit is the library's own, checked against the installed package:
//   mantine  DEFAULT_THEME.spacing (xs 10 / sm 12 / md 16 / lg 20 / xl 32)
//   mui      theme.spacing(n) = 8n
//   chakra   spacing token n = 0.25rem * n = 4n
//   tailwind gap-n / p-n = 0.25rem * n = 4n
//   vuetify  ga-n / pa-n = 4n
//   css      the literal px/rem in the pack's own `loom-*` rules
// ---------------------------------------------------------------------------

type Dialect = "mantine" | "mui" | "chakra" | "tailwind" | "vuetify" | "css";

const MANTINE_SPACING: Record<string, number> = { xs: 10, sm: 12, md: 16, lg: 20, xl: 32 };

/** Pixels for a rem/px CSS length. */
function cssLength(raw: string): number | null {
  const m = /^(-?[\d.]+)(px|rem)$/.exec(raw.trim());
  if (!m) return null;
  return m[2] === "rem" ? Math.round(parseFloat(m[1]!) * 16) : Math.round(parseFloat(m[1]!));
}

/** The FIRST gap this markup states, in px, or null when it states none. */
function resolveGap(dialect: Dialect, markup: string): number | null {
  switch (dialect) {
    case "mantine": {
      const named = /\bgap="(\w+)"/.exec(markup);
      if (named) return MANTINE_SPACING[named[1]!] ?? null;
      const num = /\bgap=\{(\d+)\}/.exec(markup);
      return num ? Number(num[1]) : null;
    }
    case "mui": {
      const m = /\b(?:gap|spacing)=\{([\d.]+)\}/.exec(markup);
      return m ? Math.round(parseFloat(m[1]!) * 8) : null;
    }
    case "chakra": {
      const m = /\bgap=\{([\d.]+)\}/.exec(markup);
      return m ? Math.round(parseFloat(m[1]!) * 4) : null;
    }
    case "tailwind":
    case "vuetify": {
      const cls = dialect === "tailwind" ? /\bgap-(\d+)\b/ : /\bga-(\d+)\b/;
      const m = cls.exec(markup);
      if (m) return Number(m[1]) * 4;
      const arb = /\bgap-\[(\d+)px\]/.exec(markup);
      return arb ? Number(arb[1]) : null;
    }
    case "css": // The Angular packs render a `loom-*` class; the distance lives in the
      // pack's theme, so the caller passes the CSS RULE as the markup.
      {
        const m = /\bgap:\s*([\d.]+(?:px|rem))/.exec(markup);
        return m ? cssLength(m[1]!) : null;
      }
  }
}

/** The FIRST padding this markup states, in px, or null. */
function resolvePadding(dialect: Dialect, markup: string): number | null {
  switch (dialect) {
    case "mantine": {
      const named = /\b(?:p|padding)="(\w+)"/.exec(markup);
      if (named) return MANTINE_SPACING[named[1]!] ?? null;
      const num = /\b(?:p|padding)=\{(\d+)\}/.exec(markup);
      return num ? Number(num[1]) : null;
    }
    case "mui": {
      const m = /\bp:\s*([\d.]+)/.exec(markup);
      return m ? Math.round(parseFloat(m[1]!) * 8) : null;
    }
    case "chakra": {
      const m = /\bp=\{\s*([\d.]+)\s*\}/.exec(markup);
      return m ? Math.round(parseFloat(m[1]!) * 4) : null;
    }
    case "tailwind":
    case "vuetify": {
      const cls = dialect === "tailwind" ? /\bp-(\d+)\b/ : /\bpa-(\d+)\b/;
      const m = cls.exec(markup);
      return m ? Number(m[1]) * 4 : null;
    }
    case "css": {
      const m = /\bpadding:\s*([\d.]+(?:px|rem))/.exec(markup);
      return m ? cssLength(m[1]!) : null;
    }
  }
}

// ---------------------------------------------------------------------------
// The packs under contract.  HEEx packs (coreComponents, daisyui) are out of
// scope: LiveView's shell owns spacing through core_components, not through
// per-primitive templates, so it has its own contract.
// ---------------------------------------------------------------------------

interface PackUnderTest {
  readonly family: string;
  readonly version: string;
  readonly dialect: Dialect;
  /** Template that carries this pack's `loom-*` CSS, for the `css` dialect
   *  and for the class-driven structural rules. */
  readonly cssTemplates: readonly string[];
}

const PACKS: readonly PackUnderTest[] = [
  { family: "mantine", version: "v7", dialect: "mantine", cssTemplates: ["app-shell"] },
  { family: "mantine", version: "v9", dialect: "mantine", cssTemplates: ["app-shell"] },
  { family: "mui", version: "v5", dialect: "mui", cssTemplates: [] },
  { family: "mui", version: "v7", dialect: "mui", cssTemplates: [] },
  { family: "chakra", version: "v2", dialect: "chakra", cssTemplates: [] },
  { family: "chakra", version: "v3", dialect: "chakra", cssTemplates: [] },
  { family: "shadcn", version: "v3", dialect: "tailwind", cssTemplates: ["globals-css"] },
  { family: "shadcn", version: "v4", dialect: "tailwind", cssTemplates: ["globals-css"] },
  { family: "shadcnVue", version: "v1", dialect: "tailwind", cssTemplates: ["globals-css"] },
  { family: "shadcnSvelte", version: "v1", dialect: "tailwind", cssTemplates: ["globals-css"] },
  { family: "flowbite", version: "v1", dialect: "tailwind", cssTemplates: ["globals-css"] },
  { family: "vuetify", version: "v3", dialect: "vuetify", cssTemplates: ["app-shell"] },
  {
    family: "angularMaterial",
    version: "v1",
    dialect: "css",
    cssTemplates: ["theme", "app-shell"],
  },
  { family: "primeng", version: "v1", dialect: "css", cssTemplates: ["theme", "app-shell"] },
  { family: "spartanNg", version: "v1", dialect: "css", cssTemplates: ["theme", "app-shell"] },
];

const packId = (p: PackUnderTest) => `${p.family}@${p.version}`;

/**
 * A deviation the contract knows about and someone else owns.  The entry
 * asserts the pack STILL renders `actualPx` — so when its owner fixes the
 * pack, THIS test fails and the fix deletes the entry.  A waiver that cannot
 * go stale is not a waiver, it is a second contract.
 */
/** Structural concerns a sibling mission owns, same ratchet as the numeric
 *  ones: the entry asserts the pack still FAILS, so the fix deletes it. */
const KNOWN_STRUCTURAL_DEVIATIONS: readonly { pack: string; concern: string; owner: string }[] = [
  { pack: "mui@v5", concern: "toolbar.alignment", owner: "M-FT.20 (#2748)" },
  { pack: "mui@v7", concern: "toolbar.alignment", owner: "M-FT.20 (#2748)" },
  { pack: "mui@v5", concern: "navSection.label", owner: "M-FT.20 (#2748)" },
  { pack: "mui@v7", concern: "navSection.label", owner: "M-FT.20 (#2748)" },
  { pack: "chakra@v2", concern: "navSection.label", owner: "M-FT.18 (#2745)" },
  { pack: "chakra@v3", concern: "navSection.label", owner: "M-FT.18 (#2745)" },
  { pack: "flowbite@v1", concern: "container.size", owner: "M-FT.19 (#2750)" },
  { pack: "mui@v5", concern: "main.padding", owner: "M-FT.20 (#2748)" },
  { pack: "mui@v7", concern: "main.padding", owner: "M-FT.20 (#2748)" },
  { pack: "chakra@v2", concern: "main.padding", owner: "M-FT.18 (#2745)" },
  { pack: "chakra@v3", concern: "main.padding", owner: "M-FT.18 (#2745)" },
  { pack: "flowbite@v1", concern: "main.padding", owner: "M-FT.19 (#2750)" },
  { pack: "mui@v5", concern: "main.contained", owner: "M-FT.20 (#2748)" },
  { pack: "mui@v7", concern: "main.contained", owner: "M-FT.20 (#2748)" },
  { pack: "chakra@v2", concern: "main.contained", owner: "M-FT.18 (#2745)" },
  { pack: "chakra@v3", concern: "main.contained", owner: "M-FT.18 (#2745)" },
  { pack: "flowbite@v1", concern: "main.contained", owner: "M-FT.19 (#2750)" },
];

function structuralDeviation(pack: string, concern: string): boolean {
  return KNOWN_STRUCTURAL_DEVIATIONS.some((d) => d.pack === pack && d.concern === concern);
}

interface KnownDeviation {
  readonly pack: string;
  readonly concern: SpacingConcern;
  readonly actualPx: number | null;
  readonly owner: string;
}

const KNOWN_DEVIATIONS: readonly KnownDeviation[] = [
  // M-FT.20 (#2748) owns the MUI Stack and toolbar; M-FT.18 (#2745) owns the
  // Chakra VStack; M-FT.19 (#2750) owns designs/flowbite/** entire.
  { pack: "mui@v5", concern: "stack.gap", actualPx: null, owner: "M-FT.20 (#2748)" },
  { pack: "mui@v7", concern: "stack.gap", actualPx: null, owner: "M-FT.20 (#2748)" },
  { pack: "mui@v5", concern: "toolbar.gap", actualPx: null, owner: "M-FT.20 (#2748)" },
  { pack: "mui@v7", concern: "toolbar.gap", actualPx: null, owner: "M-FT.20 (#2748)" },
  { pack: "chakra@v2", concern: "stack.gap", actualPx: null, owner: "M-FT.18 (#2745)" },
  { pack: "chakra@v3", concern: "stack.gap", actualPx: null, owner: "M-FT.18 (#2745)" },
  { pack: "flowbite@v1", concern: "group.gap", actualPx: 16, owner: "M-FT.19 (#2750)" },
  { pack: "flowbite@v1", concern: "keyValueRow.gap", actualPx: 16, owner: "M-FT.19 (#2750)" },
  {
    pack: "flowbite@v1",
    concern: "formSubmitRow.marginTop",
    actualPx: null,
    owner: "M-FT.19 (#2750)",
  },
  { pack: "flowbite@v1", concern: "card.padding", actualPx: null, owner: "M-FT.19 (#2750)" },
];

function deviationFor(pack: string, concern: SpacingConcern): KnownDeviation | undefined {
  return KNOWN_DEVIATIONS.find((d) => d.pack === pack && d.concern === concern);
}

// ---------------------------------------------------------------------------
// The fixture.  One primitive call's worth of context, identical for every
// pack — the walker passes exactly these keys (see
// src/generator/_walker/primitives/layout.ts).
// ---------------------------------------------------------------------------

const CHILD = "<!-- child -->";
const layoutCtx = {
  hasChildren: true,
  childrenBlock: CHILD,
  children: [CHILD],
  indent: "  ",
  closeIndent: "",
  innerIndent: "  ",
  deepIndent: "    ",
  deeperIndent: "      ",
  headIndent: "  ",
  rowIndent: "    ",
  cellIndent: "      ",
  bodyIndent: "    ",
  testidAttr: "",
  styleAttr: "",
  a11yAttr: ' role="toolbar"',
  // `styleWith` is supplied per render by the walker (walker-core.ts), not
  // by the pack — the fixture stands in for it so a size-aware template
  // renders instead of throwing on an undefined helper.
  styleWith: (style: string) => ` style="${style}"`,
};

const cardCtx = {
  ...layoutCtx,
  hasTitle: true,
  titleText: "T",
  hasContent: true,
  contentJsx: CHILD,
};
const kvCtx = {
  label: "L",
  labelAttr: ' label="L"',
  childJsx: CHILD,
  testidAttr: "",
  styleAttr: "",
};
const formCtx = {
  ...layoutCtx,
  fieldHtmls: [CHILD],
  submitBody: "{}",
  submitPendingExpr: "pending",
  submitTestid: "t",
  submitLabel: "Save",
};
const tableCtx = {
  ...layoutCtx,
  hasColumns: true,
  columns: [{ header: "H", cellJsx: CHILD }],
  rowsExpr: "rows",
  rowVar: "r",
  keyExpr: "r.id",
};
const containerCtx = { ...layoutCtx, hasSize: true, size: "md" };

/** Render one logical template, or return null when the pack has no such
 *  template (charts on the non-charting packs, forms on Angular). */
function render(pack: ReturnType<typeof loadPack>, name: string, ctx: unknown): string | null {
  if (!pack.templates.has(name)) return null;
  return pack.render(name, ctx);
}

/** The RAW source of one of the pack's templates, by logical name.
 *  Structural probes (CSS rules, a component's class list, a shell's section
 *  label) read the source rather than render it: those strings are literal in
 *  the template, and Handlebars runs in strict mode here, so rendering a whole
 *  app-shell would demand the walker's entire context just to reach three CSS
 *  declarations. */
function source(p: PackUnderTest, logicalName: string): string {
  const dir = path.join(designs, p.family, p.version);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "pack.json"), "utf8")) as {
    emits: Record<string, string>;
  };
  const file = manifest.emits[logicalName];
  if (!file) return "";
  const full = path.join(dir, file);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : "";
}

/** The pack's own stylesheet text — where the `css` dialect keeps its
 *  distances and where every pack keeps its `loom-*` chrome rules. */
function packCss(p: PackUnderTest): string {
  return p.cssTemplates.map((t) => source(p, t)).join("\n");
}

/** The CSS rule body for one class, from a stylesheet blob. */
function cssRule(css: string, selector: string): string | null {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  return m ? m[1]! : null;
}

interface Probe {
  /** What the concern resolves to for this pack, in px; null = unstated. */
  readonly px: number | null;
  /** What was measured, for the failure message. */
  readonly evidence: string;
  /** The pack has no such surface at all (the Angular packs build their forms
   *  procedurally, so there is no `primitive-form-of` to carry a submit row).
   *  Not a deviation — there is nothing to state. */
  readonly notApplicable?: boolean;
}

function probe(
  pack: ReturnType<typeof loadPack>,
  p: PackUnderTest,
  concern: SpacingConcern,
): Probe {
  const css = () => packCss(p);
  const viaCss = (selector: string, kind: "gap" | "padding"): Probe => {
    const rule = cssRule(css(), selector);
    if (rule === null) return { px: null, evidence: `no CSS rule ${selector}` };
    return {
      px: kind === "gap" ? resolveGap("css", rule) : resolvePadding("css", rule),
      evidence: `${selector} { ${rule.trim().replace(/\s+/g, " ")} }`,
    };
  };
  const viaMarkup = (
    template: string,
    ctx: unknown,
    kind: "gap" | "padding",
    cssSelector?: string,
  ): Probe => {
    if (p.dialect === "css" && cssSelector) return viaCss(cssSelector, kind);
    const markup = render(pack, template, ctx);
    if (markup === null) return { px: null, evidence: `pack has no ${template}` };
    return {
      px: kind === "gap" ? resolveGap(p.dialect, markup) : resolvePadding(p.dialect, markup),
      evidence: markup.split("\n")[0]!.slice(0, 160),
    };
  };

  switch (concern) {
    case "stack.gap":
      return viaMarkup("primitive-stack", layoutCtx, "gap", ".loom-stack");
    case "group.gap":
      return viaMarkup("primitive-group", layoutCtx, "gap", ".loom-group");
    case "toolbar.gap":
      return viaMarkup("primitive-toolbar", layoutCtx, "gap", ".loom-toolbar");
    case "paper.padding":
      return viaMarkup("primitive-paper", layoutCtx, "padding", ".loom-paper");
    case "card.padding": {
      if (p.dialect === "css") {
        // The Angular packs' card body is either the library's own element or
        // `.loom-card-content`; both are pinned in the pack's CSS.
        for (const sel of [".loom-card-content", "mat-card", ".p-card .p-card-body"]) {
          const found = viaCss(sel, "padding");
          if (found.px !== null) return found;
        }
        return { px: null, evidence: "no card padding rule" };
      }
      // The shadcn family puts the padding on its own Card COMPONENT source
      // rather than on the call site, so follow it there.
      const own = render(pack, "primitive-card", cardCtx);
      if (own !== null && resolvePadding(p.dialect, own) !== null) {
        return { px: resolvePadding(p.dialect, own), evidence: own.split("\n")[0]!.slice(0, 160) };
      }
      for (const t of ["components-ui-card", "components-ui-card-content"]) {
        const comp = source(p, t);
        if (!comp) continue;
        // Every class list in the component file, first one that states a
        // padding wins — the card ROOT states none, the body/header do.
        for (const m of comp.matchAll(/(?:className=\{cn\(|class=)"([^"]*)"/g)) {
          const px = resolvePadding(p.dialect, m[1]!);
          if (px !== null) return { px, evidence: `${t}: ${m[1]}` };
        }
      }
      return { px: null, evidence: "card padding unstated" };
    }
    case "keyValueRow.gap": {
      if (p.dialect === "css") return viaCss(".loom-key-value-row", "gap");
      const own = render(pack, "primitive-key-value-row", kvCtx);
      if (own === null) return { px: null, evidence: "no primitive-key-value-row" };
      if (!own.includes("<KeyValueRow")) {
        return { px: resolveGap(p.dialect, own), evidence: own.slice(0, 160) };
      }
      // Component-delegating packs keep the row in format-helpers.
      const helpers = source(p, "format-helpers");
      const at = helpers.indexOf("export function KeyValueRow");
      const fn = at < 0 ? "" : helpers.slice(at).split("\n").slice(0, 24).join("\n");
      const row = fn.split("\n").find((l) => /<(Group|Stack|HStack|div)/.test(l)) ?? "";
      return { px: resolveGap(p.dialect, row), evidence: row.trim().slice(0, 160) };
    }
    case "formSubmitRow.gap":
    case "formSubmitRow.marginTop": {
      const form = render(pack, "primitive-form-of", formCtx);
      if (form === null) {
        return { px: null, evidence: "pack has no primitive-form-of", notApplicable: true };
      }
      const row = form.split("\n").find((l) => /flex-end|justify-end/.test(l)) ?? "";
      if (concern === "formSubmitRow.gap") {
        return { px: resolveGap(p.dialect, row), evidence: row.trim().slice(0, 160) };
      }
      return { px: resolveMarginTop(p.dialect, row), evidence: row.trim().slice(0, 160) };
    }
    default:
      return { px: null, evidence: "not a numeric concern" };
  }
}

/** Top margin, in px, from the pack's own spelling. */
function resolveMarginTop(dialect: Dialect, markup: string): number | null {
  switch (dialect) {
    case "mantine": {
      const m = /\bmt="(\w+)"/.exec(markup);
      return m ? (MANTINE_SPACING[m[1]!] ?? null) : null;
    }
    case "mui": {
      const m = /\bmt:\s*([\d.]+)/.exec(markup);
      return m ? Math.round(parseFloat(m[1]!) * 8) : null;
    }
    case "chakra": {
      const m = /\bmt=\{([\d.]+)\}/.exec(markup);
      return m ? Math.round(parseFloat(m[1]!) * 4) : null;
    }
    case "tailwind":
    case "vuetify": {
      const m = (dialect === "tailwind" ? /\bmt-(\d+)\b/ : /\bmt-(\d+)\b/).exec(markup);
      return m ? Number(m[1]) * 4 : null;
    }
    case "css":
      return null;
  }
}

const NUMERIC_CONCERNS: readonly SpacingConcern[] = [
  "stack.gap",
  "group.gap",
  "toolbar.gap",
  "paper.padding",
  "card.padding",
  "keyValueRow.gap",
  "formSubmitRow.marginTop",
  "formSubmitRow.gap",
];

const loaded = PACKS.map((p) => ({
  p,
  pack: loadPack(path.join(designs, p.family, p.version)),
}));

describe("cross-pack spacing contract", () => {
  it("the scale is the one the doc publishes", () => {
    expect(SPACING_SCALE).toEqual({ xs: 4, sm: 8, md: 16, lg: 24, xl: 32 });
  });

  for (const concern of NUMERIC_CONCERNS) {
    const want = rulePx(SPACING_CONTRACT[concern])!;
    describe(`${concern} = ${want}px`, () => {
      for (const { p, pack } of loaded) {
        const id = packId(p);
        const dev = deviationFor(id, concern);
        it(dev ? `${id} still deviates (owner: ${dev.owner})` : id, () => {
          const got = probe(pack, p, concern);
          if (got.notApplicable) return;
          if (dev) {
            // Ratchet: the day this pack conforms, this assertion fails and
            // the entry must go.
            expect(
              got.px,
              `${id} no longer deviates on ${concern} (${got.evidence}) — delete its KNOWN_DEVIATIONS entry`,
            ).toBe(dev.actualPx);
            return;
          }
          expect(
            got.px,
            `${id} states no ${concern} — a pack must state its spacing, not inherit a library default (${got.evidence})`,
          ).not.toBeNull();
          expect(
            Math.abs(got.px! - want),
            `${id} resolves ${concern} to ${got.px}px, contract says ${want}px (${got.evidence})`,
          ).toBeLessThanOrEqual(SPACING_TOLERANCE_PX);
        });
      }
    });
  }

  describe("toolbar.alignment — a centred, space-between row", () => {
    for (const { p, pack } of loaded) {
      const deviates = structuralDeviation(packId(p), "toolbar.alignment");
      it(deviates ? `${packId(p)} still deviates` : packId(p), () => {
        const markup =
          p.dialect === "css"
            ? (cssRule(packCss(p), ".loom-toolbar") ?? "")
            : (render(pack, "primitive-toolbar", layoutCtx) ?? "");
        const centred =
          /align-?[iI]tems[=:]\s*"?(center|"center")|align="center"|\bitems-center\b|\balign-center\b/.test(
            markup,
          );
        const between =
          /justify-?(?:content|Content)?[=:]\s*"?space-between"?|\bjustify-between\b|\bjustify-space-between\b/.test(
            markup,
          );
        if (deviates) {
          expect(
            centred && between,
            `${packId(p)} toolbar now conforms — delete its KNOWN_STRUCTURAL_DEVIATIONS entry`,
          ).toBe(false);
          return;
        }
        expect(
          centred,
          `${packId(p)} toolbar is not cross-axis centred: ${markup.slice(0, 160)}`,
        ).toBe(true);
        expect(
          between,
          `${packId(p)} toolbar is not main-axis space-between: ${markup.slice(0, 160)}`,
        ).toBe(true);
      });
    }
  });

  describe("table.scrollContainer — a wide table scrolls itself", () => {
    for (const { p, pack } of loaded) {
      const id = packId(p);
      it(id, () => {
        const markup = render(pack, "primitive-table", tableCtx) ?? "";
        const css = packCss(p);
        const ownWrapper =
          /overflow-x-auto|overflow-auto|overflowX|overflow-x:\s*auto|loom-table-scroll/.test(
            markup,
          ) || /\.loom-table-scroll\s*\{[^}]*overflow-x:\s*auto/.test(css);
        // A library element that scrolls on the pack's behalf counts, and is
        // named here so the claim is auditable rather than implicit.
        const libraryWrapper =
          /<TableContainer/.test(markup) || // mui
          /<Table\.ScrollArea/.test(markup) || // chakra
          /<v-table/.test(markup) || // vuetify: .v-table__wrapper overflows
          /<Table\b/.test(markup); // shadcn family: its own Table wraps in overflow-auto
        expect(
          ownWrapper || libraryWrapper,
          `${id} renders a bare table — a wide table must scroll inside a container, not widen the document`,
        ).toBe(true);
      });
    }
  });

  describe("container.size — the author's size reaches the markup", () => {
    for (const { p, pack } of loaded) {
      const deviates = structuralDeviation(packId(p), "container.size");
      it(deviates ? `${packId(p)} still deviates` : packId(p), () => {
        const sized = render(pack, "primitive-container", containerCtx) ?? "";
        const unsized = render(pack, "primitive-container", { ...containerCtx, hasSize: false });
        const honoured = sized !== unsized;
        if (deviates) {
          expect(
            honoured,
            `${packId(p)} now honours \`size:\` — delete its KNOWN_STRUCTURAL_DEVIATIONS entry`,
          ).toBe(false);
          return;
        }
        expect(
          honoured,
          `${packId(p)} renders the same container with and without \`size:\` — the author's size is dropped`,
        ).toBe(true);
      });
    }
  });

  describe("main.padding — md on a phone, lg from the `lg` breakpoint", () => {
    for (const { p } of loaded) {
      const id = packId(p);
      const deviates = structuralDeviation(id, "main.padding");
      it(deviates ? `${id} still deviates` : id, () => {
        const shell = `${source(p, "app-shell")}\n${packCss(p)}`;
        // Every dialect spells "one step wider at `lg`" differently; what the
        // rule needs is that the shell states BOTH steps rather than one
        // fixed inset for a phone and a 27-inch monitor alike.
        const responsive =
          /\bp-4\b[^"]*\blg:p-6\b/.test(shell) || // tailwind
          /\bpa-4\b[^"]*\bpa-lg-6\b/.test(shell) || // vuetify
          /padding=\\?\{\{\s*base:\s*"md",\s*lg:\s*"lg"\s*\}\}/.test(shell) || // mantine
          /@media\s*\(min-width:\s*1024px\)[^}]*\{[^}]*padding:\s*(?:24px|1\.5rem)/.test(shell); // the loom-* CSS packs
        if (deviates) {
          expect(
            responsive,
            `${id} <main> now states both padding steps — delete its KNOWN_STRUCTURAL_DEVIATIONS entry`,
          ).toBe(false);
          return;
        }
        expect(
          responsive,
          `${id} <main> states one fixed padding — the contract is md below \`lg\` and lg above it`,
        ).toBe(true);
      });
    }
  });

  describe("main.contained — <main> sets min-width: 0", () => {
    for (const { p } of loaded) {
      const id = packId(p);
      const deviates = structuralDeviation(id, "main.contained");
      it(deviates ? `${id} still deviates` : id, () => {
        const shell = `${source(p, "app-shell")}\n${packCss(p)}`;
        // Without this a <main> that is a flex child keeps `min-width: auto`,
        // so a wide table widens the FLEX ITEM and the document scrolls
        // sideways — the scroll container inside it never gets to do its job.
        const contained = /\bmin-w-0\b/.test(shell) || /min-?[wW]idth:\s*0/.test(shell);
        if (deviates) {
          expect(
            contained,
            `${id} <main> is now contained — delete its KNOWN_STRUCTURAL_DEVIATIONS entry`,
          ).toBe(false);
          return;
        }
        expect(
          contained,
          `${id} <main> never sets min-width: 0, so a wide table widens the document instead of scrolling inside its container`,
        ).toBe(true);
      });
    }
  });

  describe("navSection.label — one style across every pack", () => {
    for (const { p, pack } of loaded) {
      const id = packId(p);
      const deviates = structuralDeviation(id, "navSection.label");
      it(deviates ? `${id} still deviates` : id, () => {
        const shell = source(p, "app-shell");
        const css = `${shell}\n${packCss(p)}`;
        const uppercase = /uppercase/.test(shell) || /text-transform:\s*uppercase/.test(css);
        const small = /text-xs\b/.test(shell) || /font-size:\s*0\.75rem/.test(css);
        const semibold =
          /font-semibold/.test(shell) || /font-weight:\s*600/.test(css) || /fw=\{600\}/.test(shell);
        if (deviates) {
          expect(
            uppercase && small && semibold,
            `${id} section label now matches the shared style — delete its KNOWN_STRUCTURAL_DEVIATIONS entry`,
          ).toBe(false);
          return;
        }
        expect(
          uppercase && small && semibold,
          `${id} sidebar section label is not the shared style (uppercase/12px/600)`,
        ).toBe(true);
      });
    }
  });
});
