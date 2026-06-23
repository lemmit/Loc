// Regression: a generated xUnit test for a currentUser-gated operation must
// compile.
//
// Two op shapes, two test shapes:
//   • An op that uses currentUser AS DATA keeps a trailing `User currentUser`
//     param, so its test call must supply the synthetic admin actor (else
//     CS7036) — see the second case below.
//   • An AUTHZ-ONLY op (currentUser used only in `requires`) has its 403 gate
//     relocated to the handler and its domain method is param-less, so the test
//     calls it with NO actor — the case below (`rename` only writes `name`, a
//     non-currentUser field).
// Both must also avoid `var __ = <void-call>` (CS0815): a void op call is a
// statement, not an assignment.  The .NET test emitter is at parity with Hono's
// (which re-gates the same way).  The generated `Tests/` project is not compiled
// by any gate, so a regression here would ship silently.

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

// Data-use variant: the op writes a currentUser-derived value (`actor :=
// currentUser.role`), so it KEEPS its `User currentUser` param — its test call
// must supply the synthetic admin actor.
const SRC_DATA_USE = `
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
        actor: string
        operation rename(newName: string) {
          requires currentUser.role == "admin"
          name := newName
          actor := currentUser.role
        }
        test "renaming to empty is rejected" {
          let o = Order.create({ name: "demo", actor: "x" })
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
  it("authz-only op: calls with NO actor (param dropped) and does not bind a void call to var", async () => {
    const files = await generateSystemFiles(SRC);
    const testFile = [...files.entries()].find(([p]) => p.endsWith("OrderTests.cs"))?.[1];
    expect(testFile, "OrderTests.cs").toBeDefined();
    // The op is authz-only (currentUser only in `requires`) → its domain method
    // is pure (no `User` param), so the test calls it with no actor.
    expect(testFile).toMatch(/o\.Rename\(""\)/);
    expect(testFile).not.toMatch(/"admin"/);
    // A void operation call is a statement, not `var __ = <void>`.
    expect(testFile).not.toMatch(/var __ = o\.Rename/);
  });

  it("data-use op: injects a synthetic actor and brings in the Auth using", async () => {
    const files = await generateSystemFiles(SRC_DATA_USE);
    const testFile = [...files.entries()].find(([p]) => p.endsWith("OrderTests.cs"))?.[1];
    expect(testFile, "OrderTests.cs").toBeDefined();
    // The op uses currentUser AS DATA → keeps its param; the test supplies the
    // synthetic admin actor.
    expect(testFile).toMatch(/o\.Rename\(""\s*,\s*[^)]*"admin"[^)]*\)/);
    expect(testFile).not.toMatch(/var __ = o\.Rename/);
    // The actor type (Auth-layer User) must be in scope.
    expect(testFile).toContain("using Api.Auth;");
  });
});
