// A `requires` gate — or a value-object invariant — that calls a
// `domainService` renders `Rules.Fee(...)` unqualified, so the hosting C# file
// must carry `using <ns>.Domain.Services;` or it is CS0103 ("the name 'Rules'
// does not exist in the current context").  `collectCsExprUsings` adds it, but
// only when the caller passes the project namespace — and for the whole life of
// the parameter it was OPTIONAL, documented as "omitted by collectors that
// never sit beside a domain-service call".  Three collectors took that
// exemption and were wrong:
//
//   * `lifecycleGate` (cqrs/commands.ts) — the `create` / `destroy` gate.  Its
//     sibling `gateUsings` (the named-`operation` gate) DID pass `ns`, so
//     `TouchHandler.cs` compiled and `DestroyOrderHandler.cs` did not.  Row
//     F2-CB-C7-domainservice-in-requires-guard.
//   * `renderValueObject` (emit/enums-vos.ts) — a VO invariant.
//   * the folded-projection gate (projection-emit.ts) and the TPC/TPH base
//     derived collector (emit/entity.ts), latent on the same seam.
//
// The fix makes `ns` REQUIRED on `collectCsExprUsings` / `collectCsStmtUsings`,
// so the omission is a compile error in the toolchain rather than a compile
// error in the generated app.  This suite pins the two shapes that were
// observably broken plus the operation gate that already worked, so the
// asymmetry cannot come back.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

const GATE_SRC = `
system C7 {
  subdomain S {
    context Ord {
      aggregate Order {
        code: string
        quantity: int = 0
        destroy {
          requires Rules.Fee(quantity) == 0
        }
        operation touch() requires Rules.Fee(quantity) == 0 {
          quantity := quantity + 1
        }
      }
      repository Orders for Order { }
      domainService Rules {
        operation Fee(q: int): int {
          return q
        }
      }
    }
  }
  api OrdApi from S
  storage primary { type: postgres }
  resource ordState { for: Ord, kind: state, use: primary }
  deployable d {
    platform: dotnet
    contexts: [Ord]
    dataSources: [ordState]
    serves: OrdApi
    port: 4000
  }
}
`;

const VO_SRC = `
system C7c {
  subdomain S {
    context Ord {
      valueobject Money {
        amount: decimal
        invariant Rules.Fee(1) >= 0
      }
      aggregate Order {
        code: string
        price: Money
      }
      repository Orders for Order { }
      domainService Rules {
        operation Fee(q: int): int {
          return q
        }
      }
    }
  }
  api OrdApi from S
  storage primary { type: postgres }
  resource ordState { for: Ord, kind: state, use: primary }
  deployable d {
    platform: dotnet
    contexts: [Ord]
    dataSources: [ordState]
    serves: OrdApi
    port: 4000
  }
}
`;

function bySuffix(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no generated file ending in ${suffix}`);
  return files.get(key)!;
}

describe(".NET — a domain-service call in a gate imports Domain.Services", () => {
  it("the DESTROY (lifecycle) gate handler imports the service namespace", async () => {
    const files = await generateSystemFiles(GATE_SRC);
    const handler = bySuffix(files, "Application/Orders/Commands/DestroyOrderHandler.cs");
    // The call the gate renders — unqualified, so the using is load-bearing.
    expect(handler).toContain("Rules.Fee(aggregate.Quantity)");
    expect(handler).toContain("using D.Domain.Services;");
  });

  it("the OPERATION gate handler imports it too (the arm that already worked)", async () => {
    const files = await generateSystemFiles(GATE_SRC);
    const handler = bySuffix(files, "Application/Orders/Commands/TouchHandler.cs");
    expect(handler).toContain("Rules.Fee(aggregate.Quantity)");
    expect(handler).toContain("using D.Domain.Services;");
  });

  it("a value-object invariant calling a domain service imports it", async () => {
    const files = await generateSystemFiles(VO_SRC);
    const vo = bySuffix(files, "Domain/ValueObjects/Money.cs");
    expect(vo).toContain("Rules.Fee(1)");
    expect(vo).toContain("using D.Domain.Services;");
  });

  it("the service class the gate calls really lives in that namespace", async () => {
    const files = await generateSystemFiles(GATE_SRC);
    const svc = bySuffix(files, "Domain/Services/Rules.cs");
    expect(svc).toContain("namespace D.Domain.Services;");
    expect(svc).toContain("public static class Rules");
  });
});
