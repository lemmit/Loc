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
// `loomMinLength`/`loomMaxLength` (emitted at `src/lib/loom-validators.ts`)
// are the same validators counted with `[...value].length`, emitting the same
// `minlength`/`maxlength` error keys so the error rendering is unchanged.

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

describe("Angular length validators count code points", () => {
  it("emits the code-point helper module", async () => {
    const files = await angularFiles();
    const helper = files.get("web/src/lib/loom-validators.ts");
    expect(helper).toBeTruthy();
    // The counting rule itself — the whole point of the module.
    expect(helper).toContain("[...value].length");
    expect(helper).toContain("export function loomMinLength(n: number): ValidatorFn {");
    expect(helper).toContain("export function loomMaxLength(n: number): ValidatorFn {");
    // Same error keys as Angular's built-ins, so error rendering is unchanged.
    expect(helper).toContain("minlength: { requiredLength: n, actualLength }");
    expect(helper).toContain("maxlength: { requiredLength: n, actualLength }");
  });

  it("length constraints render loomMinLength / loomMaxLength, never the UTF-16 built-ins", async () => {
    const files = await angularFiles();
    const page = files.get("web/src/app/pages/product-new.component.ts")!;
    expect(page).toBeTruthy();
    expect(page).toContain("loomMinLength(3)");
    expect(page).toContain("loomMaxLength(8)");
    // The built-ins count UTF-16 code units — they must not survive anywhere.
    expect(page).not.toContain("Validators.minLength");
    expect(page).not.toContain("Validators.maxLength");
    // …and the helper is imported.
    expect(page).toContain(
      'import { loomMaxLength, loomMinLength } from "../../lib/loom-validators";',
    );
  });

  it("NUMERIC constraints keep Angular's built-ins (no code-point question there)", async () => {
    const files = await angularFiles();
    const page = files.get("web/src/app/pages/product-new.component.ts")!;
    expect(page).toContain("Validators.min(1)");
    // …so the `Validators` import is still pulled in alongside the helpers.
    expect(page).toContain("import { FormControl, FormGroup, ReactiveFormsModule, Validators }");
  });
});
