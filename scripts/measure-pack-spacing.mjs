#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Measure the REAL DOM against the cross-pack spacing contract.
//
//   node scripts/measure-pack-spacing.mjs '{"react-mantine":4200,"react-shadcn":4201}'
//   node scripts/measure-pack-spacing.mjs '{"vue-vuetify":"http://localhost:4300"}' --list /issues
//
// The template gate (`test/generator/_packs/pack-spacing-contract.test.ts`)
// proves each pack SAYS 16px in its own dialect.  It cannot prove the library
// then RENDERS 16px — a `gap="md"` against a themed Mantine provider, a
// `gap-4` that Tailwind never compiled because the class was built at runtime,
// a `.loom-stack` rule a component style overrode.  This closes that half by
// reading `getComputedStyle` off running generated apps, exactly the way the
// divergence was originally found (the field-test measurement dump).
//
// It is deliberately a SCRIPT plus an opt-in vitest wrapper rather than a CI
// lane: measuring N packs means booting N generated stacks with a database
// behind them, which is minutes per pack.  `npm run test:pack-spacing-dom`
// runs it against whatever you already have up.
//
// Exit code 0 = every measured value inside the contract's tolerance band.
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  SPACING_CONTRACT,
  SPACING_SCALE,
  SPACING_TOLERANCE_PX,
} from "../out/generator/_packs/spacing-contract.js";

const targets = JSON.parse(process.argv[2] ?? "{}");
const args = process.argv.slice(3);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const LIST_PATH = argOf("--list", "/");
const OUT = argOf("--out", null);
const PHONE_WIDTH = Number(argOf("--phone", "390"));

if (Object.keys(targets).length === 0) {
  console.error(
    "usage: measure-pack-spacing.mjs '{\"<pack label>\": <port or url>}' [--list /issues] [--out measures.json]",
  );
  process.exit(2);
}

/** Read the governed distances off a live page. */
const measure = (page) =>
  page.evaluate(() => {
    const px = (v) => Math.round(Number.parseFloat(v) || 0);
    const cs = (el) => (el ? getComputedStyle(el) : null);
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const main =
      document.querySelector("main") ??
      document.querySelector("[role=main]") ??
      document.querySelector("#main-content");
    // The page's root Stack is the first block container under <main>; every
    // scaffolded page emits one, carrying the page testid.
    const stack =
      main?.querySelector(
        "[data-testid$='-list'], [data-testid$='-detail'], [data-testid$='-page'], [data-testid='home']",
      ) ??
      main?.firstElementChild ??
      null;
    const toolbar = document.querySelector("[role=toolbar]");
    const table = document.querySelector("main table, main [role=table]");
    const scroller = (() => {
      // The nearest ancestor of the table that actually scrolls horizontally.
      let el = table?.parentElement ?? null;
      while (el && el !== document.body) {
        const o = getComputedStyle(el).overflowX;
        if (o === "auto" || o === "scroll") return el;
        el = el.parentElement;
      }
      return null;
    })();
    const navSection = document.querySelector(
      "[data-testid=nav-sidebar] p, [data-testid=nav-sidebar] .loom-nav-section, .loom-nav-section",
    );
    const mainCs = cs(main);
    const stackCs = cs(stack);
    const toolbarCs = cs(toolbar);
    const sectionCs = cs(navSection);
    return {
      "stack.gap": stackCs && stackCs.display.includes("flex") ? px(stackCs.rowGap) : null,
      "toolbar.gap": toolbarCs ? px(toolbarCs.columnGap) : null,
      "main.padding": mainCs ? px(mainCs.paddingLeft) : null,
      "main.contained": mainCs ? mainCs.minWidth === "0px" || px(mainCs.minWidth) === 0 : null,
      "table.scrollContainer": table ? scroller !== null : null,
      "navSection.label": sectionCs
        ? {
            size: px(sectionCs.fontSize),
            weight: sectionCs.fontWeight,
            transform: sectionCs.textTransform,
          }
        : null,
      toolbarAlign: toolbarCs ? toolbarCs.alignItems : null,
      documentScrollsSideways:
        document.documentElement.scrollWidth > document.documentElement.clientWidth,
      visibleBlocks: stack ? [...stack.children].filter(visible).length : 0,
    };
  });

const want = (concern) => {
  const rule = SPACING_CONTRACT[concern];
  return rule.token === undefined ? undefined : SPACING_SCALE[rule.token];
};

const browser = await chromium.launch();
const results = {};
const failures = [];

for (const [label, target] of Object.entries(targets)) {
  const base = typeof target === "number" ? `http://localhost:${target}` : String(target);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const page = await ctx.newPage();
  try {
    await page.goto(base + LIST_PATH, { waitUntil: "networkidle", timeout: 30_000 });
    await page.waitForTimeout(500);
    const desktop = await measure(page);
    await page.setViewportSize({ width: PHONE_WIDTH, height: 800 });
    await page.waitForTimeout(400);
    const phone = await measure(page);
    results[label] = { desktop, phone };

    const check = (concern, got, expected) => {
      if (got === null || got === undefined) return; // primitive absent on this page
      if (Math.abs(got - expected) > SPACING_TOLERANCE_PX) {
        failures.push(`${label}: ${concern} measured ${got}px, contract says ${expected}px`);
      }
    };
    check("stack.gap", desktop["stack.gap"], want("stack.gap"));
    check("toolbar.gap", desktop["toolbar.gap"], want("toolbar.gap"));
    check("main.padding", desktop["main.padding"], want("main.padding"));
    if (desktop["table.scrollContainer"] === false) {
      failures.push(`${label}: the table has no horizontal-scroll container`);
    }
    // The one that matters most on a phone: a wide table must scroll ITSELF.
    if (phone.documentScrollsSideways) {
      failures.push(
        `${label}: the document scrolls sideways at ${PHONE_WIDTH}px — <main> is not contained`,
      );
    }
    const lbl = desktop["navSection.label"];
    if (lbl && (lbl.transform !== "uppercase" || Math.abs(lbl.size - 12) > 2)) {
      failures.push(
        `${label}: sidebar section label is ${lbl.size}px/${lbl.transform}, contract says 12px/uppercase`,
      );
    }
    console.log(`${label}: measured (${desktop.visibleBlocks} page blocks)`);
  } catch (e) {
    results[label] = { error: String(e).split("\n")[0] };
    failures.push(`${label}: ${String(e).split("\n")[0]}`);
  } finally {
    await ctx.close();
  }
}
await browser.close();

if (OUT) writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
if (failures.length > 0) {
  console.error(`\n${failures.length} contract violation(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nevery measured value is inside the ±${SPACING_TOLERANCE_PX}px band`);
