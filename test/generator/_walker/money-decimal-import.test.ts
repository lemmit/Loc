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

// ---------------------------------------------------------------------------
// M-T1.23 — the import has ONE owner, and the count is the assertion.
//
// The tests above ask whether the binding is PRESENT.  Presence is exactly
// what passed while the generated app did not build: every React/Svelte pack
// declares `imports."field-input-money" = [{from: "decimal.js", named:
// ["Decimal"]}]`, and the page shell independently scans its own rendered body
// and emits `import Decimal from "decimal.js";`.  A money FORM FIELD fires
// both — the pack template contains `new Decimal(…)`, so the scan sees it —
// and the page ends up with two `Decimal` bindings: `TS2300: Duplicate
// identifier` under tsc, `Identifier 'Decimal' has already been declared`
// under svelte-check.  `containsIn`-style assertions cannot see that; only
// counting can.
// ---------------------------------------------------------------------------

/** Every `… from "decimal.js"` line in an emitted page, in source order. */
function decimalImportLines(src: string): string[] {
  return src.split("\n").filter((l) => /^\s*import\s.*\bfrom\s+["']decimal\.js["']/.test(l));
}

const MONEY_FORM_SYSTEM = (framework: string): string => `
system MF {
  subdomain D {
    context C {
      aggregate A { name: string  price: money  derived display: string = name }
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
      body: CreateForm(of: A)
    }
  }
  deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
  deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
}
`;

describe("a money form field yields exactly one decimal.js import (M-T1.23)", () => {
  it("react and svelte — the pack declares it, the shell owns it, the page gets one", async () => {
    // The two frameworks whose packs declare `decimal.js` under
    // `field-input-money`.  Before the shell drained that declaration these
    // pages carried BOTH the pack's `import { Decimal } from "decimal.js"` and
    // the shell's `import Decimal from "decimal.js"`.
    for (const framework of ["react", "svelte"] as const) {
      const files = await generateSystemFiles(MONEY_FORM_SYSTEM(framework));
      const src = [...files].find(([k]) => PAGE_OF[framework]!.test(k))?.[1] ?? "";
      expect(src, `${framework}: no page emitted`).not.toBe("");
      // The witness holds only while the page really renders the money field.
      expect(src, `${framework}: page must bind Decimal for this test to mean anything`).toContain(
        'new Decimal("0")',
      );
      const lines = decimalImportLines(src);
      expect(
        lines,
        `${framework}: expected ONE decimal.js import, got ${lines.length}:\n${lines.join("\n")}`,
      ).toHaveLength(1);
      // …and it is the shell's default import, the single canonical form.
      expect(lines[0]).toContain('import Decimal from "decimal.js"');
    }
  }, 300_000);

  it("vue and angular — no pack declaration, and still never two", async () => {
    // The negative side of the same invariant: these packs declare no
    // decimal.js entry, so the drain must be a no-op that changes nothing.
    for (const framework of ["vue", "angular"] as const) {
      const files = await generateSystemFiles(MONEY_FORM_SYSTEM(framework));
      const src = [...files].find(([k]) => PAGE_OF[framework]!.test(k))?.[1] ?? "";
      expect(src, `${framework}: no page emitted`).not.toBe("");
      const lines = decimalImportLines(src);
      expect(
        lines.length,
        `${framework}: expected at most one decimal.js import, got ${lines.length}:\n${lines.join("\n")}`,
      ).toBeLessThanOrEqual(1);
    }
  }, 300_000);
});

describe("the FormState alias rides a type-only import specifier (M-T1.23)", () => {
  // The alias is a `type` export (`export type CreateAFormState = z.input<…>`),
  // and SvelteKit's generated tsconfig turns `verbatimModuleSyntax` on — under
  // it a plain VALUE import of a type is a hard svelte-check error:
  //   TS1484: 'CreateAFormState' is a type and must be imported using a
  //   type-only import when 'verbatimModuleSyntax' is enabled.
  // So the walker registers the alias through `addTypeImport`, which stores the
  // inline `type X` import SPECIFIER — the form `verbatimModuleSyntax`
  // prescribes, and valid TS on every frontend that already accepted the plain
  // import.  Without this, the svelte-shop money witness's build cell is red
  // even with the decimal drain in place.
  it("react and svelte money-form pages import `type <Action>FormState`, never the value form", async () => {
    for (const framework of ["react", "svelte"] as const) {
      const files = await generateSystemFiles(MONEY_FORM_SYSTEM(framework));
      const src = [...files].find(([k]) => PAGE_OF[framework]!.test(k))?.[1] ?? "";
      expect(src, `${framework}: no page emitted`).not.toBe("");
      expect(src, `${framework}: the alias must arrive as an inline type specifier`).toMatch(
        /import \{[^}]*\btype CreateAFormState\b[^}]*\} from/,
      );
      expect(
        src,
        `${framework}: a bare value import of the alias is TS1484 under verbatimModuleSyntax`,
      ).not.toMatch(/[{,]\s*CreateAFormState/);
    }
  }, 300_000);

  // The svelte-shop matrix witness rides the OPERATION form (crudish `update`
  // on the scaffolded Detail page), which registers its alias at a different
  // call site than `CreateForm` — pin that site too.
  it("an OperationForm page imports its `type <Op><Agg>FormState` the same way", async () => {
    const files = await generateSystemFiles(`
      system OF {
        subdomain D {
          context C {
            aggregate A {
              name: string
              price: money
              derived display: string = name
              operation reprice(price: money) { }
            }
            repository As for A { }
          }
        }
        api Api from D
        storage pg { type: postgres }
        resource st { for: C, kind: state, use: pg }
        ui W {
          framework: svelte
          api C: Api
          page P(id: A id) { route: "/p/:id" body: OperationForm(of: A, op: reprice) }
        }
        deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
        deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
      }
    `);
    const src = [...files].find(([k]) => PAGE_OF.svelte!.test(k))?.[1] ?? "";
    expect(src, "no svelte page emitted").not.toBe("");
    expect(src).toMatch(/import \{[^}]*\btype RepriceAFormState\b[^}]*\} from/);
    expect(src).not.toMatch(/[{,]\s*RepriceAFormState/);
  }, 300_000);
});

describe("a React component brings its own `Decimal` into scope (M-T1.23)", () => {
  // The component shell computed a decimal import and then dropped it —
  // `const _decimalImport = …` was never spliced into the returned file.  A
  // `component` with a money `state {}` field therefore emitted
  // `useState<Decimal>(new Decimal("1.50"))` with nothing importing `Decimal`
  // (TS2304).  Nothing caught it because a component that ALSO hosted a money
  // form got the pack's `field-input-money` declaration by accident — and
  // draining that declaration (the fix above) takes the accident away, so the
  // real owner had to be wired in the same change.
  it("a money `state {}` field in a component imports decimal.js exactly once", async () => {
    const files = await generateSystemFiles(`
      system CM {
        subdomain D {
          context C {
            aggregate A { name: string  price: money  derived display: string = name }
            repository As for A { }
          }
        }
        api Api from D
        storage pg { type: postgres }
        resource st { for: C, kind: state, use: pg }
        ui W {
          framework: react
          api C: Api
          component Wallet() {
            state { amt: money = money("1.50") }
            body: Text(string(amt))
          }
          page P { route: "/p" body: Wallet() }
        }
        deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
        deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
      }
    `);
    const src = [...files].find(([k]) => /\/src\/components\/Wallet\.tsx$/.test(k))?.[1] ?? "";
    expect(src, "no component emitted").not.toBe("");
    expect(src, "the component really does bind Decimal").toContain('new Decimal("1.50")');
    const lines = decimalImportLines(src);
    expect(
      lines,
      `expected ONE decimal.js import in the component, got ${lines.length}:\n${lines.join("\n")}`,
    ).toHaveLength(1);
  }, 300_000);
});

describe("the Svelte api module exports the dual FormState/Payload aliases (M-T1.23)", () => {
  // Found while building the Svelte half of the witness above.  `moneySchema`
  // is the one wire schema that TRANSFORMS on parse (decimal string in,
  // `Decimal` out), so a money-bearing action's `z.input` differs from its
  // `z.output` and the form emitter binds `<Action>FormState` (the pre-parse
  // shape) rather than the request type.  The React api module emits that pair;
  // the SVELTE api module is a second emitter of the same schema surface and
  // never did — so any Svelte money form failed svelte-check with "Module
  // '$lib/api/<agg>' has no exported member 'Create<Agg>FormState'".  Same
  // witness gap as the duplicate import: no Svelte build-matrix example had a
  // money field in a form.
  const MONEY_SYSTEM = `
    system SM {
      subdomain D {
        context C {
          aggregate A {
            name: string
            price: money
            derived display: string = name
            operation reprice(price: money) { }
          }
          repository As for A { }
        }
      }
      api Api from D
      storage pg { type: postgres }
      resource st { for: C, kind: state, use: pg }
      ui W { framework: svelte  api C: Api  page P { route: "/p" body: CreateForm(of: A) } }
      deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
      deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
    }
  `;

  it("a money create input and a money operation each get their alias pair", async () => {
    const files = await generateSystemFiles(MONEY_SYSTEM);
    const src = [...files].find(([k]) => /\/src\/lib\/api\/a\.ts$/.test(k))?.[1] ?? "";
    expect(src, `no svelte api module emitted: ${[...files.keys()].join(", ")}`).not.toBe("");
    for (const name of [
      "export type CreateAFormState = z.input<typeof CreateARequest>;",
      "export type CreateAPayload = z.output<typeof CreateARequest>;",
      "export type RepriceAFormState = z.input<typeof RepriceARequest>;",
      "export type RepriceAPayload = z.output<typeof RepriceARequest>;",
    ]) {
      expect(src, `svelte api module must export: ${name}`).toContain(name);
    }
  }, 300_000);

  it("a money-free action gets no aliases — they would be structurally identical", async () => {
    const files = await generateSystemFiles(`
      system SN {
        subdomain D {
          context C {
            aggregate B { name: string  derived display: string = name }
            repository Bs for B { }
          }
        }
        api Api from D
        storage pg { type: postgres }
        resource st { for: C, kind: state, use: pg }
        ui W { framework: svelte  api C: Api  page P { route: "/p" body: CreateForm(of: B) } }
        deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
        deployable web { platform: static, targets: api, ui: W { C: api }, port: 3001 }
      }
    `);
    const src = [...files].find(([k]) => /\/src\/lib\/api\/b\.ts$/.test(k))?.[1] ?? "";
    expect(src).not.toBe("");
    expect(src).not.toContain("FormState");
    expect(src).not.toContain("Payload");
  }, 300_000);
});
