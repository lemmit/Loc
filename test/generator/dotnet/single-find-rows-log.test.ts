// A NON-optional single `find` did not compile on .NET (#2659, found while
// compile-proving the handler-triad fixture).
//
// The repository emitter logged every single-row find's row count as
// `result == null ? 0 : 1`.  For a `T?` find that is right — the terminal is
// `FirstOrDefault` and the return type admits null.  For a NON-optional one the
// terminal is `First()`/`FirstAsync` (which throws on empty, so the row is never
// null) and the comparison is not merely dead: it teaches C#'s nullable flow
// analysis that `result` MAY be null, and the `return result;` on the next line
// becomes **CS8603 Possible null reference return** — fatal under the emitted
// project's `/warnaserror`.
//
//   public async Task<Order> ByCode(string c, CancellationToken ct = default)
//   {
//       var result = await _db.Orders.Where(x => x.Code == c).FirstAsync(ct);
//       _log.LogDebug(…, "byCode", result == null ? 0 : 1);  // ← teaches maybe-null
//       return result;                                      // ← CS8603
//   }
//
// No corpus fixture declares a non-optional single find, which is why the whole
// shape was unwitnessed.  (Its ABSENCE semantics also diverge five ways —
// node/.NET throw, java/python/elixir return null — a parity finding recorded in
// `test/fixtures/corpus/handler-triad.ddd`, not fixed here.)
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const SRC = (findRet: string) => `
system S {
  subdomain D {
    context Sales {
      aggregate Order { code: string  status: string }
      repository Orders for Order {
        find byCode(c: string): ${findRet} where code == c
      }
    }
  }
  api A from D
  storage pg { type: postgres }
  resource s { for: Sales, kind: state, use: pg }
  deployable d { platform: dotnet  contexts: [Sales]  dataSources: [s]  serves: A  port: 5001 }
}
`;

async function repository(findRet: string): Promise<string> {
  const m = await generateSystemFiles(SRC(findRet));
  const key = [...m.keys()].find((k) =>
    k.endsWith("Infrastructure/Repositories/OrderRepository.cs"),
  );
  expect(key, `OrderRepository.cs not emitted; have:\n${[...m.keys()].join("\n")}`).toBeDefined();
  return m.get(key!)!;
}

describe(".NET — a single find's `rows=` log value follows its nullability", () => {
  it("a NON-optional single find logs a constant 1 and returns non-null", async () => {
    const repo = await repository("Order");
    expect(repo).toContain("public async Task<Order> ByCode(");
    expect(repo).toContain("FirstAsync(cancellationToken)");
    expect(repo).toContain('"byCode", 1);');
    // The null comparison is what produced CS8603 on the `return result;` below.
    expect(repo).not.toContain('"byCode", result == null ? 0 : 1);');
  });

  it("an OPTIONAL single find keeps the comparison (FirstOrDefault really can be null)", async () => {
    const repo = await repository("Order?");
    expect(repo).toContain("public async Task<Order?> ByCode(");
    expect(repo).toContain("FirstOrDefaultAsync(cancellationToken)");
    expect(repo).toContain('"byCode", result == null ? 0 : 1);');
  });

  it("an ARRAY find is unchanged — it counts the list", async () => {
    expect(await repository("Order[]")).toContain('"byCode", result.Count);');
  });
});
