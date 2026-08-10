// Scalar intrinsics in Phoenix HEEx page bodies — the third and last target
// drained (after Feliz's F# table #2439 and Flutter's Dart table #2466) in
// the frontend-intrinsic slice of the frontend-expression plan.
//
// HEEx is architecturally separate from the other five frontends: it does not
// consume `_walker/walker-core.ts`'s shared `emitExpr` — `heex-walker-core.ts`
// runs a parallel engine, because LiveView's output topology diverges (inline
// lambdas vs hoisted `handle_event` clauses, `for`-comprehensions vs `.map`,
// `if`-blocks vs ternaries). Its own `renderMethodCall` had no intrinsic arm,
// so a page-body call like `s.toUpper()` fell through to a VERBATIM
// `recv.member(args)`, snake-cased on the way out into `s.to_upper()` — not a
// real `String` function, so it fails at `mix compile`.
//
// Unlike Feliz/Flutter, Elixir already had a complete, TESTED domain-side
// table (`ELIXIR_INTRINSIC_RENDERERS` in `render-expr.ts`, coverage pinned by
// `intrinsic-completeness.test.ts` and snippet-correctness pinned by
// `intrinsic-trim.test.ts`) — reused here, not re-authored, so a page body and
// an aggregate `derived` agree on what `s.replace(a, b)` means. HEEx page
// bodies always render in-memory (never an Ecto query filter position), so
// only that table — not `ECTO_INTRINSIC_FRAGMENTS` — is reachable from a page.
//
// This suite pins the WIRING (a page-body method-call reaches the table via
// `heex-walker-core.ts`'s `renderMethodCall`), not the table's snippet
// correctness — that is already `intrinsic-trim.test.ts`'s job. Real Elixir
// compilation of the emitted arms is proven by `mix compile
// --warnings-as-errors` (verified manually against `expression-showcase.ddd`
// in Docker; `elixir-vanilla-build.yml` is the standing CI gate).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SYSTEM = (expr: string): string => `
system Shop {
  subdomain S {
    context Sales {
      aggregate Order with crudish { status: string }
      repository Orders for Order { }
    }
  }
  api SalesApi from S
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  ui Web {
    framework: phoenixLiveView
    api Sales: SalesApi
    page Home {
      route: "/"
      state { s: string = "hi"  n: int = 1  d: decimal = 1.5 }
      body: Text(${expr})
    }
  }
  deployable app {
    platform: elixir
    contexts: [Sales]
    dataSources: [st]
    serves: SalesApi
    ui: Web { Sales: app }
    port: 4000
  }
}
`;

async function homeLive(expr: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(expr));
  const live = [...files].find(([p]) => p.endsWith("live/home_live.ex"))?.[1];
  expect(live, `no home_live.ex in: ${[...files.keys()].join(", ")}`).toBeDefined();
  return live!;
}

describe("scalar intrinsics render in Phoenix HEEx page bodies", () => {
  it("the loud failures — the Loom spelling is translated, not emitted raw", async () => {
    for (const [expr, expected] of [
      ["s.toUpper()", "String.upcase(@s)"],
      ["s.toLower()", "String.downcase(@s)"],
      ['s.contains("a")', 'String.contains?(@s, "a")'],
      ["n.abs()", "abs(@n)"],
      ["n.min(2)", "min(@n, 2)"],
      ["n.max(2)", "max(@n, 2)"],
      ["n.divTrunc(2)", "div(@n, 2)"],
      ["d.floor()", "Decimal.round(@d, 0, :floor)"],
      ["d.ceil()", "Decimal.round(@d, 0, :ceiling)"],
    ] as const) {
      const live = await homeLive(expr);
      expect(live, `${expr} should render as ${expected}`).toContain(expected);
      // The raw `<recv>.<loomName>(` / snake-cased spelling must be gone.
      const member = expr.split(".")[1]!.split("(")[0]!;
      expect(live, `${expr} should not survive verbatim`).not.toMatch(
        new RegExp(`@s\\.(?:${member}|to_upper|to_lower)\\(`),
      );
    }
  });

  it("the ops Elixir already spelled the same are byte-identical (no churn)", async () => {
    for (const [expr, expected] of [
      ["s.trim()", "String.trim(@s)"],
      ['s.startsWith("a")', 'String.starts_with?(@s, "a")'],
      ['s.endsWith("a")', 'String.ends_with?(@s, "a")'],
      ['s.split(",")', 'String.split(@s, ",")'],
    ] as const) {
      const live = await homeLive(expr);
      expect(live).toContain(expected);
    }
  });

  it("`replace` and `substring` — the silent-wrongness pair — resolve to their catalogue meaning", async () => {
    // `String.replace/3` replaces ALL occurrences (Loom's `replace` contract),
    // matching Elixir's own default — but this pins it explicitly rather than
    // relying on coincidence, exactly as the JS/Dart/F# siblings do.
    const replaced = await homeLive('s.replace("-", " ")');
    expect(replaced).toContain('String.replace(@s, "-", " ")');

    // Loom's `substring` is start+LENGTH; `String.slice/3` is start+LENGTH too,
    // so this is a coincidence-holds case — pinned so a future table change
    // can't silently regress it to `String.slice/2` (start+END-ish) behavior.
    const sliced = await homeLive("s.substring(2, 5)");
    expect(sliced).toContain("String.slice(@s, 2, 5)");
  });

  it("`round` on money/decimal carries the bank-rounding mode explicitly", async () => {
    const live = await homeLive("d.round(2)");
    expect(live).toContain("Decimal.round(@d, 2, :half_up)");
  });
});
