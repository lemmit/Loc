// A1 pilot for the scalar-intrinsic catalogue (docs/old/plans/stdlib.md):
// `string.trim()` end-to-end on the .NET backend — in-memory rendering in
// domain bodies AND the LINQ `Where` lambda in a queryable `find … where`
// position (EF Core translates `.Trim()` to SQL natively, so no separate
// query renderer exists).  The catalogue row lives in src/util/intrinsics.ts;
// the C# snippet in render-expr.ts (CS_INTRINSIC_RENDERERS).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Catalog {
    aggregate Product {
      name: string
      derived cleanName: string = name.trim()
      invariant name.trim().length > 0
    }
    repository Products for Product {
      find byExactName(q: string): Product[] where this.name.trim() == q
    }
  }
`;

describe("dotnet generator — string.trim() intrinsic (stdlib A1 pilot)", () => {
  it("parses + validates cleanly (typed as string, queryable where)", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders trim in-memory in derived/invariant bodies", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Products/Product.cs")!;
    expect(domain).toContain(".Trim()");
  });

  it("renders trim inside the find Where lambda (EF Core translates it to SQL)", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/ProductRepository.cs")!;
    expect(repo).toContain(".Where(x => x.Name.Trim() == q)");
  });

  it("renders a value-side trim (param receiver) the same way", async () => {
    const src = `
      context Catalog {
        aggregate Product { name: string }
        repository Products for Product {
          find byName(q: string): Product[] where this.name == q.trim()
        }
      }
    `;
    const { model, errors } = await parseString(src);
    expect(errors).toEqual([]);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/ProductRepository.cs")!;
    expect(repo).toContain(".Where(x => x.Name == q.Trim())");
  });
});
