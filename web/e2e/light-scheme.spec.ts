// M-T8.23 slice 4 — the light scheme renders legibly (audit M16).
//
// The playground was written against Mantine's raw dark palette, so a viewer
// whose stored Mantine scheme was LIGHT got white-on-white panels; M-T8.16 had
// to pin `forceColorScheme="dark"` to hide it.  Slice 4 routed every raw shade
// through a semantic token and dropped the pin, which means the light scheme is
// now a rendering the app claims to support — and therefore one a gate has to
// hold to.
//
// What this measures: WCAG 2.x relative-luminance contrast between each sampled
// element's own text colour and the nearest opaque background painted behind
// it (walking up the tree past transparent ancestors, exactly as the eye does).
// The threshold is 4.5:1 — the AA bar for body text — on the panes' own chrome.
// The sample is deliberately structural (region headers, the pipeline strip,
// the dock tablist, the explorer) rather than "every node on the page": those
// are the surfaces the raw shades painted, so they are where the defect lived.
//
// The same computation runs in DARK as a control: a threshold that the shipped,
// long-reviewed dark rendering fails would be measuring the metric, not the UI.

import { expect, test, type Page } from "@playwright/test";
import { waitForPlaygroundReady } from "./_helpers";

/** The AA bar for body text. */
const MIN_CONTRAST = 4.5;

/** Structural chrome the token migration repainted.  Each is a CSS selector
 *  resolved in page context; a selector that matches nothing is reported by
 *  name rather than silently passing (the failure shape CLAUDE.md warns about:
 *  a check that never reaches the thing it names). */
const SAMPLES: Record<string, string> = {
  headerTitle: "h5",
  pipelineStrip: '[data-testid="pipeline-strip"]',
  generateSegment: '[data-testid="btn-generate"]',
  dockTablist: '[data-testid="devtools-tabs"]',
  explorerHeader: '[data-testid="explorer-mode"]',
  fileCount: '[data-testid="preview-region"]',
};

interface Measured {
  name: string;
  found: boolean;
  contrast: number;
  fg: string;
  bg: string;
}

async function measure(page: Page, samples: Record<string, string>): Promise<Measured[]> {
  return page.evaluate((sel) => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
      return [m[0] ?? 0, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1];
    };
    const lum = ([r, g, b]: number[]): number => {
      const f = (v: number): number => {
        const s = (v ?? 0) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0);
    };
    /** The nearest OPAQUE background painted behind `el`. */
    const bgOf = (el: Element): string => {
      let node: Element | null = el;
      while (node) {
        const c = getComputedStyle(node).backgroundColor;
        if (parse(c)[3] > 0.05) return c;
        node = node.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor || "rgb(255,255,255)";
    };
    return Object.entries(sel).map(([name, selector]) => {
      const el = document.querySelector(selector);
      if (!el) return { name, found: false, contrast: 0, fg: "", bg: "" };
      const fg = getComputedStyle(el).color;
      const bg = bgOf(el);
      const l1 = lum(parse(fg));
      const l2 = lum(parse(bg));
      const contrast = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return { name, found: true, contrast, fg, bg };
    });
  }, samples);
}

/** Seed Mantine's stored scheme BEFORE the app boots — this is exactly the
 *  state the audit's white-on-white viewer was in. */
async function gotoWithScheme(page: Page, scheme: "light" | "dark"): Promise<void> {
  await page.addInitScript((value) => {
    window.localStorage.setItem("mantine-color-scheme-value", value);
  }, scheme);
  await page.goto("/");
  await waitForPlaygroundReady(page);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.mantineColorScheme))
    .toBe(scheme);
}

for (const scheme of ["light", "dark"] as const) {
  test(`${scheme} scheme: the panes' chrome clears ${MIN_CONTRAST}:1`, async ({ page }) => {
    await gotoWithScheme(page, scheme);
    const measured = await measure(page, SAMPLES);

    // Every sample must have RESOLVED — a selector that matched nothing would
    // otherwise "pass" while measuring no pixels at all.
    expect(measured.filter((m) => !m.found).map((m) => m.name)).toEqual([]);

    const failures = measured
      .filter((m) => m.contrast < MIN_CONTRAST)
      .map((m) => `${m.name}: ${m.contrast.toFixed(2)}:1 (${m.fg} on ${m.bg})`);
    expect(failures, `sampled: ${measured.map((m) => `${m.name}=${m.contrast.toFixed(2)}`).join(", ")}`).toEqual([]);
  });
}

test("light scheme: no pane paints text on a background of its own colour", async ({ page }) => {
  // The literal white-on-white shape M16 describes — a token whose light value
  // was left as a dark shade produces exactly this, and a contrast threshold
  // alone can read as "passing" on an element whose text happens to be dark.
  await gotoWithScheme(page, "light");
  const same = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("[data-testid]")) {
      const s = getComputedStyle(el);
      const bg = s.backgroundColor;
      if (!bg || bg === "rgba(0, 0, 0, 0)") continue;
      if (s.color === bg) out.push(`${el.dataset.testid}: ${s.color}`);
    }
    return out;
  });
  expect(same).toEqual([]);
});
