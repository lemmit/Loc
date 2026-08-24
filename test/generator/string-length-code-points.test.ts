import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/generate.js";

// ---------------------------------------------------------------------------
// A string `.length` counts Unicode CODE POINTS, on every backend, in both
// carriers (schemathesis F5 / waiver W6).
//
// The bug this pins: the host primitives disagree about what a "character" is
// — JS `s.length`, C# `s.Length` and Java `s.length()` count UTF-16 code units
// — while the `minLength`/`maxLength` the SAME server publishes in its
// `/openapi.json` count code points.  `"😀X"` (2 code points, 3 code units)
// was therefore accepted on write and served back in violation of the
// published schema.
//
// Two carriers, deliberately both covered per backend, because they are
// separate code paths:
//   * MESSAGE-LESS single-field shapes  → the native validator chain
//     (`chainSingleFieldFluent` / the java validator / zod's chain)
//   * everything else (messaged rules, the domain floor) → the expression
//     renderer (`render-expr.ts` / `zod-refine.ts` / `renderFluentPredicate`)
//
// The snippets themselves live in `src/generator/_expr/code-point.ts`.
// ---------------------------------------------------------------------------

const SOURCE = `
  system S {
    subdomain Sales {
      context Cat {
        aggregate Product {
          code: string
          // Message-LESS single-field shapes -> each backend's NATIVE chain.
          invariant code.length >= 3
          invariant code.length <= 16
          create(code: string) { }
          operation relabel(label: string) {
            // Messaged -> the refine / predicate carrier instead.
            precondition label.length >= 4 message "Label needs at least 4 characters"
            code := label
          }
        }
        repository Products for Product { }
      }
    }
    api CatApi from Sales
    storage db { type: postgres }
    resource st { for: Cat, kind: state, use: db }
    deployable nodeApi { platform: node contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
    deployable dotnetApi { platform: dotnet contexts: [Cat] dataSources: [st] serves: CatApi port: 8081 }
    deployable javaApi { platform: java contexts: [Cat] dataSources: [st] serves: CatApi port: 8082 }
    deployable pythonApi { platform: python contexts: [Cat] dataSources: [st] serves: CatApi port: 8083 }
    deployable elixirApi { platform: elixir contexts: [Cat] dataSources: [st] serves: CatApi port: 8084 }
  }
`;

let cache: Map<string, string> | undefined;
async function gen(): Promise<Map<string, string>> {
  if (!cache) cache = await generateSystemFiles(SOURCE);
  return cache;
}

/** The one file in `files` whose path ends with `suffix`. */
async function file(suffix: string): Promise<string> {
  const all = await gen();
  const hit = [...all.keys()].find((k) => k.endsWith(suffix));
  if (!hit) throw new Error(`no emitted file ends with ${suffix}\n${[...all.keys()].join("\n")}`);
  return all.get(hit)!;
}

// A field carrying BOTH a regex and a length bound — `chainSingleFieldNative`
// is called twice on the same base, and the order is load-bearing under zod 3.
const REGEX_AND_LENGTH = `
  system R {
    subdomain Sales {
      context Cat {
        aggregate Person with crudish {
          // Length declared FIRST on purpose: the emitter must still chain the
          // refine last (orderSingleFieldPatterns).
          email: string
          invariant email.length <= 120
          invariant email.matches("^[^@]+@[^@]+$")
        }
        repository People for Person { }
      }
    }
    api CatApi from Sales
    storage db { type: postgres }
    resource st { for: Cat, kind: state, use: db }
    deployable nodeApi { platform: node contexts: [Cat] dataSources: [st] serves: CatApi port: 8080 }
  }
`;

describe("string .length is code points — node/Hono", () => {
  it("the native chain is a code-point refine, not zod's code-unit .min/.max", async () => {
    const routes = await file("node_api/http/product.routes.ts");
    expect(routes).toContain("[...s].length >= 3");
    expect(routes).toContain("[...s].length <= 16");
    // The code-unit primitives must be gone from the length constraint.
    expect(routes).not.toContain("z.string().min(3)");
    expect(routes).not.toContain(".max(16)");
  });

  it("still PUBLISHES minLength/maxLength — a refine is invisible to the OpenAPI emitter", async () => {
    const routes = await file("node_api/http/product.routes.ts");
    expect(routes).toContain(".openapi({ minLength: 3, maxLength: 16 })");
  });

  it("the messaged refine carrier counts code points too", async () => {
    const routes = await file("node_api/http/product.routes.ts");
    expect(routes).toContain("[...data.label].length >= 4");
  });

  it("the domain floor counts code points", async () => {
    const domain = await file("node_api/domain/product.ts");
    expect(domain).toContain("[...this._code].length >= 3");
    expect(domain).not.toContain("this._code.length >= 3");
  });

  it("chains the code-point refine AFTER a regex on the same field", async () => {
    // zod 3 (`platform: node@v4`, the v1 react stack) types `.refine()` as a
    // ZodEffects WRAPPER with no `.regex` on it, so `.refine(…).regex(/…/)`
    // is a type error there.  The length invariant is declared FIRST in the
    // fixture; the emitter must still order the refine last.
    const all = await generateSystemFiles(REGEX_AND_LENGTH);
    const routes = all.get(
      [...all.keys()].find((k) => k.endsWith("node_api/http/person.routes.ts"))!,
    )!;
    expect(routes).toContain(
      "email: z.string().regex(/^[^@]+@[^@]+$/).refine((s) => [...s].length <= 120).openapi({ maxLength: 120 })",
    );
  });
});

describe("string .length is code points — .NET", () => {
  it("the FluentValidation chain counts code points, not MinimumLength/MaximumLength", async () => {
    const validators = await file("Products/Commands/CreateProductCommandValidator.cs");
    expect(validators).toContain("v.EnumerateRunes().Count() >= 3");
    expect(validators).toContain("v.EnumerateRunes().Count() <= 16");
    expect(validators).not.toContain("MinimumLength(3)");
    expect(validators).not.toContain("MaximumLength(16)");
  });

  it("keeps FluentValidation's null-skip so an optional string is unaffected", async () => {
    const validators = await file("Products/Commands/CreateProductCommandValidator.cs");
    expect(validators).toContain("Must(v => v == null ||");
  });

  it("the domain floor counts code points", async () => {
    const domain = await file("Domain/Products/Product.cs");
    expect(domain).toContain("this.Code.EnumerateRunes().Count() >= 3");
    expect(domain).not.toContain("this.Code.Length >= 3");
  });
});

describe("string .length is code points — java", () => {
  it("the request validator uses codePointCount, not String.length()", async () => {
    const validator = await file("products/CreateProductValidator.java");
    expect(validator).toContain("((int) code.codePoints().count()) >= 3");
    expect(validator).toContain("((int) code.codePoints().count()) <= 16");
  });

  it("the domain floor counts code points", async () => {
    const domain = await file("products/Product.java");
    expect(domain).toContain("codePoints().count()");
    expect(domain).not.toMatch(/\(code\.length\(\) >= 3\)/);
  });
});

describe("string .length is code points — python (already correct)", () => {
  it("keeps Pydantic's min_length/max_length, which count code points", async () => {
    const wire = await file("app/http/product_routes.py");
    expect(wire).toMatch(/min_length=3/);
    expect(wire).toMatch(/max_length=16/);
  });

  it("the messaged predicate carrier uses len(), which counts code points", async () => {
    const routes = await file("app/http/product_routes.py");
    expect(routes).toContain("len(self.label) >= 4");
  });
});

describe("string .length on elixir — the signed grapheme residual", () => {
  // Elixir counts GRAPHEMES (`String.length/1`, Ecto's `validate_length/3`),
  // which agrees with code points on every astral character and diverges only
  // on combining sequences.  Ecto has no `:codepoints` count, so this is a
  // documented residual rather than a silent gap — pinned here so a future
  // change to it is a deliberate edit, not a surprise.
  it("still uses Ecto validate_length / String.length", async () => {
    const changeset = await file("cat/product_changeset.ex");
    expect(changeset).toMatch(/String\.length|validate_length/);
  });
});
