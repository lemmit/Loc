// Behavioural test for the emitted `moneyText` — the ONE money-display
// implementation every Handlebars frontend pack splices into `src/lib/format.*`
// (M-T1.25).
//
// The source constant is transpiled and EXECUTED here (the harness
// `test/generator/react/money-schema-runtime.test.ts` uses), so the contract is
// pinned by SEMANTICS, not by template text:
//
//   * default = verbatim — the wire's own digits, locale-neutral, no Number()
//     coercion, no grouping, no symbol, no re-scaling;
//   * `decimals: n` re-scales the DIGIT STRING half-away-from-zero (the
//     backends' + Postgres' rounding family), never through a float;
//   * `currency:` prefixes the code the CALLER passed, verbatim.
//
// The regression it locks down: every pack used to do
// `Number(value)` + `Intl.NumberFormat({ style: "currency", currency: "USD",
// maximumFractionDigits: 2 })`, so `"12.3456"` displayed as `"$12.35"` and the
// stored 4th decimal was unreachable in the UI.

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { MONEY_TEXT_SOURCE } from "../../../src/generator/_frontend/money-format.js";

type MoneyText = (
  value: number | string | { toString(): string },
  currency?: string,
  decimals?: number,
) => string;
type ScaleFn = (raw: string, digits: number) => string;

/** Stand-in for a decimal.js instance — money reaches a page as an OBJECT
 *  whose `toString()` carries the fixed-scale digits. */
class FakeDecimal {
  constructor(private readonly s: string) {}
  toString(): string {
    return this.s;
  }
}

function loadMoneyModule(src: string): { moneyText: MoneyText; scaleDecimalString: ScaleFn } {
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const factory = new Function(
    "exports",
    "module",
    `${js}\nreturn { moneyText: exports.moneyText, scaleDecimalString: exports.scaleDecimalString };`,
  );
  const mod = { exports: {} as Record<string, unknown> };
  return factory(mod.exports, mod) as { moneyText: MoneyText; scaleDecimalString: ScaleFn };
}

const { moneyText, scaleDecimalString } = loadMoneyModule(MONEY_TEXT_SOURCE);

describe("moneyText — default rendering is verbatim", () => {
  it("renders the wire's fixed-scale string unchanged (the 4th decimal is visible)", () => {
    expect(moneyText("12.3456")).toBe("12.3456");
  });

  it("renders MONEY_WIRE_ZERO unchanged — trailing zeros are the scale, not noise", () => {
    expect(moneyText("0.0000")).toBe("0.0000");
  });

  it("renders a decimal.js-like instance via its toString()", () => {
    expect(moneyText(new FakeDecimal("1234567.8900"))).toBe("1234567.8900");
  });

  it("adds no locale grouping separators", () => {
    expect(moneyText("1234567.8900")).not.toContain(",");
  });

  it("invents no currency symbol", () => {
    expect(moneyText("12.3456")).not.toMatch(/[$€£¥]/);
  });

  it("survives the full 19 significant digits of NUMERIC(19,4) — Number() does not", () => {
    const wire = "123456789012345.6789";
    expect(moneyText(wire)).toBe(wire);
    // The witness: the old implementation's float hop loses digits here.
    expect(String(Number(wire))).not.toBe(wire);
  });

  it("passes a non-numeric value through untouched", () => {
    expect(moneyText("n/a")).toBe("n/a");
  });

  it("renders a plain number argument through String()", () => {
    expect(moneyText(12.5)).toBe("12.5");
  });
});

describe("moneyText — declared `decimals:` re-scales the digit string", () => {
  it("narrows half-away-from-zero: 12.3456 @2 -> 12.35", () => {
    expect(moneyText("12.3456", undefined, 2)).toBe("12.35");
  });

  it("rounds an exact half away from zero: 12.345 @2 -> 12.35", () => {
    expect(moneyText("12.345", undefined, 2)).toBe("12.35");
  });

  it("rounds a NEGATIVE exact half away from zero: -12.345 @2 -> -12.35", () => {
    expect(moneyText("-12.345", undefined, 2)).toBe("-12.35");
  });

  it("does not round up below the half: 12.3449 @2 -> 12.34", () => {
    expect(moneyText("12.3449", undefined, 2)).toBe("12.34");
  });

  it("widens by padding zeros: 12.3456 @6 -> 12.345600", () => {
    expect(moneyText("12.3456", undefined, 6)).toBe("12.345600");
  });

  it("drops the point entirely at @0: 12.5 -> 13", () => {
    expect(moneyText("12.5", undefined, 0)).toBe("13");
  });

  it("carries across nines: 9.999 @2 -> 10.00", () => {
    expect(moneyText("9.999", undefined, 2)).toBe("10.00");
  });

  it("grows a new leading digit when every digit was a nine: 99.99 @1 -> 100.0", () => {
    expect(moneyText("99.99", undefined, 1)).toBe("100.0");
  });

  it("re-scales the 19-digit extreme exactly — no float hop", () => {
    expect(moneyText("123456789012345.6789", undefined, 2)).toBe("123456789012345.68");
  });

  it("leaves a non-numeric value alone even when decimals are declared", () => {
    expect(moneyText("n/a", undefined, 2)).toBe("n/a");
  });
});

describe("moneyText — declared `currency:` prefixes the caller's code verbatim", () => {
  it('currency: "EUR" -> "EUR 12.3456" (the code, never a guessed symbol)', () => {
    expect(moneyText("12.3456", "EUR")).toBe("EUR 12.3456");
  });

  it("combines with decimals", () => {
    expect(moneyText("12.3456", "EUR", 2)).toBe("EUR 12.35");
  });

  it("never defaults to USD when nothing was declared", () => {
    expect(moneyText("12.3456")).not.toContain("USD");
  });
});

describe("scaleDecimalString — the string-level rescale in isolation", () => {
  it("returns the input untouched for a negative digit count", () => {
    expect(scaleDecimalString("12.3456", -1)).toBe("12.3456");
  });

  it("normalizes a leading-zero integer part after a carry: 09.99 @1 -> 10.0", () => {
    expect(scaleDecimalString("09.99", 1)).toBe("10.0");
  });

  it("keeps a bare integer intact and pads it: 12 @4 -> 12.0000", () => {
    expect(scaleDecimalString("12", 4)).toBe("12.0000");
  });

  it("accepts an explicit + sign but does not re-emit it", () => {
    expect(scaleDecimalString("+12.3456", 2)).toBe("12.35");
  });
});
