// Regression: a generated xUnit test for a `requires currentUser` operation
// must compile.
//
// A `test { expect(p.rename("")).toThrow() }` block, where `rename` carries
// `requires currentUser`, lowered to:
//     Assert.Throws<DomainException>(() => { var __ = p.Rename(""); });
// Two C# compile errors: (a) `Rename(string, User)` was called with ONE arg
// (CS7036), because the synthetic actor the currentUser-gated signature needs
// was never supplied; (b) `var __ = <void-call>` assigns a void return
// (CS0815).  The Hono backend already injects a synthetic admin actor for the
// same source test — this brings .NET to parity.  The generated `Tests/` project
// is not compiled by any gate, so this shipped silently.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const SRC = `
system Acme {
  user {
    id: guid
    role: string
    permissions: string[]
  }
  subdomain Sales {
    context S {
      aggregate Order {
        name: string
        operation rename(newName: string) {
          requires currentUser.role == "admin"
          name := newName
        }
        test "renaming to empty is rejected" {
          let o = Order.create({ name: "demo" })
          expect(o.rename("")).toThrow()
        }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from Sales
  storage primarySql { type: postgres }
  resource sState { for: S, kind: state, use: primarySql }
  deployable api {
    platform: dotnet
    contexts: [S]
    dataSources: [sState]
    serves: SalesApi
    port: 3001
  }
}
`;

describe("dotnet — aggregate test for a currentUser-gated operation compiles", () => {
  it("calls the gated op with no synthetic actor — there is no gate left to satisfy", async () => {
    const files = await generateSystemFiles(SRC);
    const testFile = [...files.entries()].find(([p]) => p.endsWith("OrderTests.cs"))?.[1];
    expect(testFile, "OrderTests.cs").toBeDefined();
    // The gate is hoisted to the command handler (op-gates.ts), so the method
    // signature no longer takes a principal; passing the old actor would now be
    // an excess argument and fail `dotnet build /warnaserror`.
    expect(testFile).toMatch(/o\.Rename\(""\)/);
    expect(testFile).not.toMatch(/o\.Rename\(""\s*,/);
    // A void operation call is a statement, not `var __ = <void>`.
    expect(testFile).not.toMatch(/var __ = o\.Rename/);
  });
});
