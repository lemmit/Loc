// F2-XB-2 — Angular length validators must count CODE POINTS, like every
// other target.
//
// Angular is the only frontend that derives NATIVE validators from a
// `SingleFieldPattern`; it emits no zod schema, so there is no second, correct
// gate behind them.  It used to emit `Validators.minLength(3)` /
// `Validators.maxLength(8)`, and Angular's built-ins read `value.length` —
// UTF-16 CODE UNITS.  Every other target counts code points: the shared zod
// schema is `z.string().refine((s) => [...s].length >= 3)` and the Hono route
// agrees.  So a two-emoji name ("👍👍", 2 code points / 4 UTF-16 units) passed
// the Angular form and was rejected by the server with a 422 the form had no
// field error for; the mirror case rejected client-side what the server would
// have accepted.
//
// WHAT THIS FILE PINS, AND WHY IT IS SPELLED THIS WAY.  Two implementations of
// this row were written in parallel.  This branch emitted a
// `src/lib/loom-validators.ts` module (`loomMinLength` / `loomMaxLength`);
// #2734 landed an INLINE `ValidatorFn` built on the shared `tsCodePointLength`
// instead.  #2734's is the better of the two — one fewer emitted file, and the
// counting rule comes from the same helper the zod path uses rather than a
// second copy — so the module was deleted and these assertions were retargeted
// at the shipped spelling.
//
// The assertions are deliberately about BEHAVIOUR (code points are counted;
// the UTF-16 built-ins appear nowhere; numeric bounds still use the built-ins,
// which have no code-point question) rather than about the exact lambda text,
// so a future refactor of how the validator is spelled does not break them —
// only a regression to `Validators.minLength` would.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function angularFiles(): Promise<Map<string, string>> {
  return generateSystemFiles(`
    system Demo {
      subdomain S {
        context C {
          aggregate Product {
            name: string
            sku: string
            qty: int
            invariant name.length >= 3
            invariant sku.length <= 8
            invariant qty >= 1
          }
          repository Products for Product { }
        }
      }
      api Api from S
      ui Web {
        api C: Api
        page ProductNew { route: "/products/new" body: CreateForm { of: Product } }
      }
      storage loomDb { type: postgres }
      resource st { for: C, kind: state, use: loomDb }
      deployable api { platform: node, contexts: [C], dataSources: [st], serves: Api, port: 3000 }
      deployable web { platform: angular, targets: api, ui: Web { C: api }, port: 3001 }
    }
  `);
}

const pageOf = async (): Promise<string> => {
  const files = await angularFiles();
  const page = files.get("web/src/app/pages/product-new.component.ts");
  expect(page, "no product-new component emitted").toBeTruthy();
  return page!;
};

describe("Angular length validators count code points", () => {
  it("counts code points, not UTF-16 units", async () => {
    const page = await pageOf();
    // The counting rule itself — spread-then-length is the code-point count.
    expect(page).toContain("[...String(c.value)].length >= 3");
    expect(page).toContain("[...String(c.value)].length <= 8");
  });

  it("never falls back to the UTF-16 built-ins", async () => {
    const page = await pageOf();
    // The regression this row exists for.  `"👍👍"` is 2 code points and 4
    // UTF-16 units, so these two spellings disagree on exactly the input the
    // server judges by code points.
    expect(
      page,
      "Validators.minLength counts UTF-16 code units — the server counts code points",
    ).not.toContain("Validators.minLength");
    expect(page).not.toContain("Validators.maxLength");
  });

  it("keeps the same `minlength` / `maxlength` error keys", async () => {
    const page = await pageOf();
    // Error RENDERING is shared with the built-in path, so the keys must not
    // drift or the field error stops being announced.
    expect(page).toContain("minlength: { requiredLength: 3 }");
    expect(page).toContain("maxlength: { requiredLength: 8 }");
  });

  it("leaves NUMERIC constraints on Angular's built-ins", async () => {
    const page = await pageOf();
    // No code-point question for a number, so the built-in is correct and the
    // `Validators` import stays pulled in.
    expect(page).toContain("Validators.min(1)");
    expect(page).toContain("Validators }");
  });

  it("treats an empty control as the required-validator's business, not the length one's", async () => {
    const page = await pageOf();
    // A length bound that also failed on empty would double-report with
    // `required`, so the guard short-circuits — pinned because it is the part
    // most easily lost in a refactor of the lambda.
    expect(page).toContain('c.value == null || c.value === ""');
  });
});
