// Scalar intrinsics on the JS-embedding frontends (React / Vue / Svelte /
// Angular) — the follow-up to `loom.frontend-collection-op-unsupported`.
//
// Loom's intrinsic SPELLING is its own; every backend translates it through a
// per-language snippet table.  The frontend walker had no such arm, so its
// `method-call` fallthrough emitted the Loom spelling VERBATIM.  Three ways
// that went wrong, and the third is the reason this suite exists:
//
//   1. coincidence holds  — `trim` / `startsWith` / `endsWith` / `split`
//      spell and mean the same in JS.  Already correct; pinned so the table
//      swap didn't change them.
//   2. coincidence fails LOUDLY — `toUpper` / `toLower` / `contains` don't
//      exist on a JS string, and no numeric intrinsic exists on a JS number.
//      TS2339 at build time.
//   3. coincidence fails SILENTLY — `replace` and `substring` DO exist in JS
//      but mean something ELSE.  Compiled clean and produced different
//      results in a page body than the identical expression produced in an
//      aggregate `derived`.  That cross-surface disagreement is the invariant
//      this suite locks down.
//
// The fix is one shared table (`_expr/js-intrinsics.ts`): the JS frontends and
// the Hono/TypeScript backend emit the same language, so they now use the same
// snippets rather than the frontend having no table at all.

import { describe, expect, it } from "vitest";
import {
  JS_INTRINSIC_RENDERERS,
  renderJsIntrinsic,
  usesDecimalBinding,
} from "../../../src/generator/_expr/js-intrinsics.js";
import { TS_INTRINSIC_RENDERERS } from "../../../src/generator/typescript/render-expr.js";
import { INTRINSIC_SIGNATURES, intrinsicKey } from "../../../src/util/intrinsics.js";
import { generateSystemFiles } from "../../_helpers/index.js";

const PAGE_OF: Record<string, string> = {
  react: "web/src/pages/x.tsx",
  vue: "web/src/pages/x.vue",
  svelte: "x/+page.svelte",
  angular: "web/src/app/pages/x.component.ts",
};

/** Generate a system whose page body renders `expr` over page state, and
 *  whose aggregate carries the SAME expression as a `derived` — so the two
 *  emissions can be compared directly. */
async function genBoth(expr: string, framework = "react", backendDerived = false) {
  // The aggregate `derived` is the BACKEND half of the cross-surface pairs, and
  // it is opt-in: only a STRING-valued expression can be bound to a
  // `derived …: string`, and only the two cross-surface tests read it.
  //
  // It used to be emitted unconditionally as `convert(<expr>, string)` — which
  // is NOT Loom syntax (the cast form is `string(v)`), so every fixture here
  // carried a parser error.  Langium error-recovery produced a usable-looking
  // AST, the assertions were all on the PAGE half, and the suite passed
  // regardless; `generateSystemFiles` now rejects a fixture with syntax errors
  // (#2354) rather than asserting against error-recovered garbage, which is
  // what surfaced it.
  const derived = backendDerived ? `derived probe: string = ${expr}` : "";
  const files = await generateSystemFiles(`
    system S {
      subdomain Sales {
        context Orders {
          aggregate Customer {
            s: string
            n: int
            d: decimal
            ${derived}
          }
          repository Customers for Customer { }
        }
      }
      api SalesApi from Sales
      storage pg { type: postgres }
      ui WebApp {
        framework: ${framework}
        api Sales: SalesApi
        page X {
          route: "/x"
          state { s: string = "hi"  n: int = 1  d: decimal = 1.5 }
          body: Text(${expr})
        }
      }
      deployable api { platform: node, contexts: [Orders], serves: SalesApi, port: 3000 }
      deployable web { platform: static, targets: api, ui: WebApp { Sales: api }, port: 3001 }
    }
  `);
  let page = "";
  for (const [k, v] of files) if (k.includes(PAGE_OF[framework]!)) page = v;
  const backend = files.get("api/domain/customer.ts") ?? "";
  return { page, backend, files };
}

describe("scalar intrinsics render on the JS frontends", () => {
  it("the loud failures — the Loom spelling is translated, not emitted raw", async () => {
    for (const [expr, expected] of [
      ["s.toUpper()", "s.toUpperCase()"],
      ["s.toLower()", "s.toLowerCase()"],
      ['s.contains("a")', 's.includes("a")'],
      ["n.abs()", "Math.abs(n)"],
      ["n.min(2)", "Math.min(n, 2)"],
      ["n.max(2)", "Math.max(n, 2)"],
      ["n.divTrunc(2)", "Math.trunc(n / 2)"],
      ["d.floor()", "Math.floor(d)"],
      ["d.ceil()", "Math.ceil(d)"],
    ] as const) {
      const { page } = await genBoth(expr);
      expect(page, `${expr} should render as ${expected}`).toContain(expected);
      // The raw `<recv>.<loomName>(` form must be gone — that was the TS2339.
      expect(page, `${expr} should not survive verbatim`).not.toContain(`${expr.split("(")[0]}(`);
    }
  });

  it("the ops JS already spelled the same are byte-identical (no churn)", async () => {
    for (const [expr, expected] of [
      ["s.trim()", "s.trim()"],
      ['s.startsWith("a")', 's.startsWith("a")'],
      ['s.endsWith("a")', 's.endsWith("a")'],
      ['s.split(",")', 's.split(",")'],
    ] as const) {
      const { page } = await genBoth(expr);
      expect(page).toContain(expected);
    }
  });

  it("renders on all four JS frontends, not just React", async () => {
    for (const fw of ["react", "vue", "svelte", "angular"] as const) {
      const { page } = await genBoth("s.toUpper()", fw);
      // Angular reads state through a signal call (`s()`), so match the op
      // only — the receiver spelling is each framework's own business.
      expect(page, `expected toUpperCase() on ${fw}`).toContain(".toUpperCase()");
      expect(page, `raw toUpper() survived on ${fw}`).not.toContain(".toUpper()");
    }
  });
});

// ---------------------------------------------------------------------------
// The headline invariant: the SAME Loom expression must MEAN the same thing in
// an aggregate `derived` (backend) and in a page body (frontend).  These two
// were silently different before — they compiled clean on both surfaces and
// disagreed at runtime.
// ---------------------------------------------------------------------------
describe("cross-surface agreement — page body vs aggregate derived", () => {
  it("`replace` is replace-ALL on both surfaces (was: first-only in the page)", async () => {
    const { page, backend } = await genBoth('s.replace("a", "b")', "react", true);
    expect(backend).toContain('.replaceAll("a", "b")');
    expect(page).toContain('.replaceAll("a", "b")');
    // The JS `.replace(a, b)` that silently replaced only the FIRST match.
    expect(page).not.toMatch(/\.replace\("a", "b"\)/);
  });

  it("`substring` is start+LENGTH on both surfaces (was: start+END in the page)", async () => {
    const { page, backend } = await genBoth("s.substring(2, 3)", "react", true);
    expect(backend).toContain("(2) + (3)");
    expect(page).toContain("(2) + (3)");
    // The JS `.substring(2, 3)` that silently meant indices 2..3 (one char).
    expect(page).not.toContain(".substring(2, 3)");
  });

  it("every catalogue intrinsic the frontend renders matches the backend snippet", async () => {
    // Structural, not per-generation: one table, so agreement is by
    // construction — this pins that the sharing is real and not a copy.
    expect(JS_INTRINSIC_RENDERERS).toBe(TS_INTRINSIC_RENDERERS);
    for (const sig of INTRINSIC_SIGNATURES) {
      const key = intrinsicKey(sig.receiver, sig.name);
      expect(JS_INTRINSIC_RENDERERS[key], `no JS snippet for '${key}'`).toBeTypeOf("function");
    }
  });
});

// ---------------------------------------------------------------------------
// The declines — a seam that returns `undefined` falls back to the caller's
// ordinary emission.  Two reasons it declines, both deliberate.
// ---------------------------------------------------------------------------
describe("what renderJsIntrinsic declines", () => {
  const num = { kind: "primitive", name: "money" } as const;
  const str = { kind: "primitive", name: "string" } as const;

  it("declines NOTHING the table has an arm for — every catalogue row renders", () => {
    // This used to assert the OPPOSITE: `money.min` / `money.max` /
    // `money.round` were declined because they name the `Decimal` binding and
    // the frontend PAGE shells never imported decimal.js (only
    // `store-builder.ts` did).  Declining did not avoid broken output, it
    // chose a DIFFERENT broken output — the walker's verbatim fallthrough
    // emitted `amt.min(x)` / `amt.max(x)`, for which decimal.js has no
    // INSTANCE method (TS2339), and `amt.round(2)`, whose instance method
    // takes no arguments (TS2554).
    //
    // The shells now decide the import by scanning their rendered source
    // (`usesDecimalBinding`), and Angular additionally HOISTS the binding onto
    // the component class — its templates resolve identifiers against the
    // instance, never module scope, so an import alone would not have been
    // enough there.  So there is nothing left to decline.
    const declined = INTRINSIC_SIGNATURES.map((s) => intrinsicKey(s.receiver, s.name)).filter(
      (key) => {
        const [receiver, name] = key.split(".") as [string, string];
        return (
          JS_INTRINSIC_RENDERERS[key] !== undefined &&
          renderJsIntrinsic({ kind: "primitive", name: receiver } as never, name, "x", ["1"]) ===
            undefined
        );
      },
    );
    expect(declined.sort()).toEqual([]);
  });

  it("renders the three arms that name the `Decimal` binding", () => {
    const money = { kind: "primitive", name: "money" } as const;
    expect(renderJsIntrinsic(money, "min", "m", ["c"])).toBe("Decimal.min(m, c)");
    expect(renderJsIntrinsic(money, "max", "m", ["c"])).toBe("Decimal.max(m, c)");
    expect(renderJsIntrinsic(money, "round", "m", ["2"])).toBe(
      "m.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)",
    );
  });

  it("`usesDecimalBinding` sees both producers, and no false positive on text", () => {
    // The single structural signal every page shell keys its import off — it
    // must catch the intrinsic table's statics AND `exprConvert`'s
    // constructor, without firing on the word in user-authored page copy.
    expect(usesDecimalBinding("Decimal.min(m, c)")).toBe(true);
    expect(usesDecimalBinding("m.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)")).toBe(true);
    expect(usesDecimalBinding("new Decimal(v)")).toBe(true);
    expect(usesDecimalBinding("<Text>Decimal precision matters</Text>")).toBe(false);
    expect(usesDecimalBinding("const x = m.abs();")).toBe(false);
  });

  it("declines a non-intrinsic member so ordinary method-call emission still runs", () => {
    expect(renderJsIntrinsic(str, "somethingElse", "x", [])).toBeUndefined();
    expect(
      renderJsIntrinsic({ kind: "entity", name: "Customer" } as never, "toUpper", "x", []),
    ).toBeUndefined();
  });

  it("money methods that need no import DO render", () => {
    expect(renderJsIntrinsic(num, "abs", "m", [])).toBe("m.abs()");
    expect(renderJsIntrinsic(num, "floor", "m", [])).toBe("m.floor()");
    expect(renderJsIntrinsic(num, "ceil", "m", [])).toBe("m.ceil()");
  });
});
