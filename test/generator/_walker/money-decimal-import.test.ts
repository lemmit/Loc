// The `Decimal` binding in a page body — one signal, four frontends, two
// different mechanics.
//
// `money` is a decimal.js `Decimal` on every JS frontend, so three catalogue
// arms name the binding itself rather than calling a method on the receiver:
// `Decimal.min(…)`, `Decimal.max(…)`, and `toDecimalPlaces(…,
// Decimal.ROUND_HALF_UP)`.  The page shells never imported decimal.js (only
// `store-builder.ts` did), so `renderJsIntrinsic` DECLINED those three — which
// did not avoid broken output, it picked a different one: the walker's
// verbatim `<recv>.<member>(…)` fallthrough emitted `amt.min(x)` / `amt.max(x)`
// (decimal.js has no INSTANCE `.min`/`.max` — TS2339) and `amt.round(2)`
// (instance `.round()` takes no arguments — TS2554).  No `.ddd` in the repo
// put a money intrinsic in a page body, so no per-frontend build gate said so.
//
// The fix has to diverge on ONE frontend, which is why it needed a decision
// rather than a uniform patch:
//
//   react / vue / svelte — markup reads module-scoped bindings, so an
//     `import Decimal from "decimal.js"` in the page file is sufficient.
//   angular — a template resolves identifiers against the COMPONENT INSTANCE,
//     never module scope.  An import alone leaves `Decimal.min(…)` unresolvable
//     in the template, so the binding is also HOISTED onto the class as
//     `protected readonly Decimal = Decimal` — the same lift the Angular shell
//     already applies to `Math` and `String`, for exactly this reason.
//
// Every shell decides its import by scanning its own RENDERED source
// (`usesDecimalBinding`), which is what makes it cover the OTHER producer too:
// `jsExprLeaves.exprConvert` emits `new Decimal(…)` for a cast to money.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const PAGE_OF: Record<string, RegExp> = {
  react: /\/src\/pages\/p\.tsx$/,
  vue: /\/src\/pages\/p\.vue$/,
  svelte: /\+page\.svelte$/,
  angular: /\/src\/app\/pages\/p\.component\.ts$/,
};

const SYSTEM = (framework: string, body: string): string => `
system S {
  subdomain D {
    context C {
      aggregate A { name: string  price: money }
      repository As for A { }
    }
  }
  api Api from D
  storage pg { type: postgres }
  resource st { for: C, kind: state, use: pg }
  ui W {
    framework: ${framework}
    api C: Api
    page P {
      route: "/p"
      state { amt: money = money("1.50")  cap: money = money("9.99") }
      body: ${body}
    }
  }
  deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
  deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
}
`;

async function page(framework: string, body: string): Promise<string> {
  const files = await generateSystemFiles(SYSTEM(framework, body));
  const found = [...files].find(([k]) => PAGE_OF[framework]!.test(k))?.[1];
  expect(found, `no page emitted for ${framework}: ${[...files.keys()].join(", ")}`).toBeDefined();
  return found!;
}

const FRAMEWORKS = ["react", "vue", "svelte", "angular"] as const;

describe("money intrinsics render in a page body on every JS frontend", () => {
  it("the three arms that name the `Decimal` binding are translated, not verbatim", async () => {
    for (const framework of FRAMEWORKS) {
      for (const [expr, expected] of [
        ["amt.min(cap)", "Decimal.min("],
        ["amt.max(cap)", "Decimal.max("],
        ["amt.round(2)", "Decimal.ROUND_HALF_UP"],
      ] as const) {
        const src = await page(framework, `Text(string(${expr}))`);
        expect(src, `${framework}: ${expr} should render as ${expected}`).toContain(expected);
        // The verbatim fallthrough is the bug's signature: an INSTANCE call
        // with the Loom spelling, which decimal.js does not define.
        const member = expr.split(".")[1]!.split("(")[0]!;
        expect(src, `${framework}: ${expr} must not survive verbatim`).not.toMatch(
          new RegExp(`amt\\(?\\)?\\.${member}\\(`),
        );
      }
    }
  }, 300_000);

  it("each page file brings the binding into scope", async () => {
    for (const framework of FRAMEWORKS) {
      const src = await page(framework, "Text(string(amt.min(cap)))");
      expect(src, `${framework} must import decimal.js`).toContain(
        'import Decimal from "decimal.js"',
      );
    }
  }, 300_000);

  // The whole reason this slice needed a design call.
  it("angular ALSO hoists the binding onto the component class", async () => {
    const src = await page("angular", "Text(string(amt.min(cap)))");
    expect(
      src,
      "an Angular template resolves against the component instance, so the import alone " +
        "would leave `Decimal.min(…)` unresolvable in the template",
    ).toContain("protected readonly Decimal = Decimal;");
  }, 300_000);

  it("a page with no `Decimal` in it does not import decimal.js", async () => {
    // The import is conditional, so a money-free page stays byte-identical.
    const files = await generateSystemFiles(`
      system S2 {
        subdomain D { context C { aggregate A { name: string } repository As for A { } } }
        api Api from D
        storage pg { type: postgres }
        resource st { for: C, kind: state, use: pg }
        ui W {
          framework: react
          api C: Api
          page P { route: "/p" state { n: int = 1 } body: Text(string(n.abs())) }
        }
        deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
        deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
      }
    `);
    const src = [...files].find(([k]) => PAGE_OF.react!.test(k))?.[1] ?? "";
    expect(src).not.toContain("decimal.js");
  }, 120_000);
});
