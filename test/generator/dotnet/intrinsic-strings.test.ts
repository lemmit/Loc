// A2 string batch of the scalar-intrinsic catalogue (docs/old/plans/stdlib.md)
// end-to-end on the .NET backend: toUpper/toLower/substring/startsWith/
// endsWith/contains/replace/split from `.ddd` source through generateDotnet.
// Semantics contract (src/util/intrinsics.ts): substring is 0-based CLAMPING
// (JS-slice), startsWith/endsWith/contains are ordinal, replace hits all
// occurrences literally, split keeps empty segments.  Only toUpper/toLower
// are queryable — they reach EF via the same renderCsExpr LINQ lambda path
// as trim (no separate SQL table on .NET).

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Catalog {
    aggregate Product {
      name: string
      derived slug: string = name.trim().toLower()
      derived shout: string = name.toUpper()
      derived cleaned: string = name.replace(" ", "-")
      derived branded: bool = name.startsWith("ACME") || name.endsWith("!") || name.contains("-")
      invariant name.substring(0, 3).length <= 3
    }
    repository Products for Product {
      find byNormalizedName(q: string): Product[] where this.name.toLower() == q
    }
  }
`;

describe("dotnet generator — string intrinsics (stdlib A2 batch)", () => {
  it("parses + validates cleanly", async () => {
    const { errors } = await parseString(SRC);
    expect(errors).toEqual([]);
  });

  it("renders the string batch in-memory in derived/invariant bodies", async () => {
    const { model } = await parseString(SRC);
    const domain = generateDotnet(model).get("Domain/Products/Product.cs")!;
    // derived slug — chained trim().toLower()
    expect(domain).toContain(".Trim().ToLowerInvariant()");
    expect(domain).toContain(".ToUpperInvariant()");
    // replace = all occurrences, literal
    expect(domain).toContain('.Replace(" ", "-")');
    // ordinal comparisons
    expect(domain).toContain('.StartsWith("ACME", StringComparison.Ordinal)');
    expect(domain).toContain('.EndsWith("!", StringComparison.Ordinal)');
    expect(domain).toContain('.Contains("-", StringComparison.Ordinal)');
    // substring — clamping guard, 2-arg arity (invariant)
    expect(domain).toContain(
      '(0 >= this.Name.Length ? "" : this.Name.Substring(0, Math.Min(3, this.Name.Length - 0))).Length <= 3',
    );
  });

  it("renders queryable toLower inside the find Where lambda (EF-translatable)", async () => {
    const { model } = await parseString(SRC);
    const repo = generateDotnet(model).get("Infrastructure/Repositories/ProductRepository.cs")!;
    expect(repo).toContain(".Where(x => x.Name.ToLower() == q)");
  });

  it("renders 1-arg substring and split in a derived body", async () => {
    const src = `
      context Catalog {
        aggregate Doc {
          body: string
          derived tail: string = body.substring(5)
          derived lineCount: int = body.split("\\n").count()
        }
      }
    `;
    const { model, errors } = await parseString(src);
    expect(errors).toEqual([]);
    const domain = generateDotnet(model).get("Domain/Docs/Doc.cs")!;
    expect(domain).toContain('(5 >= this.Body.Length ? "" : this.Body.Substring(5))');
    expect(domain).toContain('.Split("\\n").ToList()');
  });
});
