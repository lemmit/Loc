// Cross-pack money-display gate (M-T1.25).
//
// Loom `money` has no currency dimension and rides the wire as the RS-12
// fixed-scale decimal STRING ("12.3456").  Every design pack used to render it
// with `Number(value)` → `Intl.NumberFormat(undefined, { style: "currency",
// currency: "USD", maximumFractionDigits: 2 })` — so the toolchain invented a
// symbol the model never had, and the stored 4th decimal was unreachable in
// the UI.
//
// One pack fixed in isolation would leave fourteen others fabricating "$", so
// this gate walks EVERY built-in pack that emits `format-helpers` (discovered
// from `designs/*/*/pack.json`, so a NEW pack is covered the day it lands) and
// asserts the money path:
//
//   1. delegates to the single shared `moneyText(` owner, and
//   2. contains no "USD", no `style: "currency"`, and no `Number(` — the three
//      fingerprints of the old fabricate-and-round implementation.
//
// It is a TEXT gate on purpose: the semantics are pinned behaviourally in
// `test/generator/_frontend/money-format.test.ts`; what can silently rot HERE
// is one pack template drifting back to a bespoke formatter.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { MONEY_TEXT_SOURCE } from "../../../src/generator/_frontend/money-format.js";
import { loadPack } from "../../../src/generator/_packs/loader-fs.js";

const DESIGNS_DIR = path.resolve(__dirname, "..", "..", "..", "designs");

/** Every built-in pack directory (`designs/<family>/<vNN>`) whose manifest
 *  emits a `format-helpers` template. */
function packsWithFormatHelpers(): ReadonlyArray<{ label: string; dir: string }> {
  const found: Array<{ label: string; dir: string }> = [];
  for (const family of fs.readdirSync(DESIGNS_DIR).sort()) {
    const familyDir = path.join(DESIGNS_DIR, family);
    if (!fs.statSync(familyDir).isDirectory()) continue;
    for (const version of fs.readdirSync(familyDir).sort()) {
      const dir = path.join(familyDir, version);
      const manifestPath = path.join(dir, "pack.json");
      if (!fs.existsSync(manifestPath)) continue;
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
        emits?: Record<string, string>;
      };
      if (manifest.emits?.["format-helpers"]) {
        found.push({ label: `${family}@${version}`, dir });
      }
    }
  }
  return found;
}

const PACKS = packsWithFormatHelpers();

/** The money helper's body: from its `export function` line to the blank line
 *  before the next top-level declaration.  Isolating it matters — `formatNumber`
 *  legitimately uses `Intl.NumberFormat`/`Number(`, and the shared `moneyText`
 *  source below it is the delegate, not the money PATH. */
function moneyHelperBody(rendered: string): string {
  const start = rendered.search(/export function (MoneyValue|formatMoney)\b/);
  expect(start, "pack emits a MoneyValue / formatMoney helper").toBeGreaterThanOrEqual(0);
  const rest = rendered.slice(start);
  const end = rest.indexOf("\n}\n");
  expect(end, "money helper is a closed function block").toBeGreaterThan(0);
  return rest.slice(0, end + 3);
}

describe("money display — cross-pack contract", () => {
  it("discovers every built-in pack that emits format-helpers", () => {
    // A guard on the guard: if pack discovery silently returned nothing, every
    // per-pack assertion below would vacuously pass.
    expect(PACKS.length).toBeGreaterThanOrEqual(15);
  });

  for (const { label, dir } of PACKS) {
    describe(label, () => {
      const rendered = loadPack(dir, { validateRequired: false }).render("format-helpers", {
        moneySource: MONEY_TEXT_SOURCE,
      });
      const money = moneyHelperBody(rendered);

      it("delegates to the shared moneyText owner", () => {
        expect(money).toContain("moneyText(");
      });

      it("splices in the one shared implementation", () => {
        expect(rendered).toContain("export function moneyText(");
        expect(rendered).toContain("export function scaleDecimalString(");
      });

      it('fabricates no currency — no "USD", no style: "currency"', () => {
        expect(rendered).not.toContain("USD");
        expect(rendered).not.toContain('style: "currency"');
        expect(rendered).not.toContain("style: 'currency'");
      });

      it("puts no Number() float hop on the money path", () => {
        expect(money).not.toContain("Number(");
      });

      it("hardcodes no fraction-digit count on the money path", () => {
        expect(money).not.toContain("FractionDigits");
        expect(money).not.toContain("decimals = 2");
      });

      it("keeps the empty-value placeholder", () => {
        expect(money).toMatch(/isEmpty\(value\)/);
      });
    });
  }
});
