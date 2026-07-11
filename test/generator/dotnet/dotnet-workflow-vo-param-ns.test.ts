// Two .NET defects, both surfacing on a `deployable api` (C# root namespace
// `Api`) with a TRANSACTIONAL workflow that takes a value-object param:
//
//  1. Namespace doubling — the transactional command handler's injected
//     `AppDbContext` was emitted as a bare `Api.Infrastructure.Persistence.
//     AppDbContext`.  Inside `namespace Api.Application.Workflows;` the leading
//     `Api` resolves relative to the enclosing `Api.Application` namespace, so
//     the compiler reads it as `Api.Api.Infrastructure…` (CS0234 — "does not
//     exist in the namespace 'Api.Api'").  Fixed by `global::`-anchoring the
//     reference, mirroring the persisted-saga handler + the migrations DbContext
//     attribute.
//
//  2. Missing `<Vo>Request` — a workflow param typed as a value object surfaces
//     a `<Vo>Request` in the workflow's Request DTO (`record FooRequest(
//     MoneyRequest …)`), but the per-aggregate request emitter only emits
//     `<Vo>Request` for VOs reachable from an AGGREGATE's surface.  A VO that
//     appears ONLY as a workflow param had no emission, so the Request DTO
//     referenced an undefined `MoneyRequest` (CS0246).  Fixed by emitting the
//     VO request records the workflow params need into a shared
//     `Application/Workflows/WorkflowRequests.cs` (the `Application.Workflows`
//     namespace, so they resolve unqualified).
//
// Compile-gated end to end by `dotnet build /warnaserror` under LOOM_DOTNET_BUILD.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

// `Money` is referenced ONLY by the workflow param — no aggregate field/op uses
// it — so its `MoneyRequest` has no per-aggregate emission.  The deployable is
// named `api`, making the C# root namespace `Api`.
const SRC = `
  system S {
    subdomain Sales {
      context Sales {
        valueobject Money {
          amount: decimal
          currency: string
          invariant amount >= 0
        }
        aggregate Account {
          owner: string
          balance: decimal
          operation deposit(amount: decimal) { balance := balance + amount }
        }
        repository Accounts for Account {}
        workflow recordPayment transactional {
          create(payment: Money, accountId: Account id) {
            let account = Accounts.getById(accountId)
          }
        }
      }
    }
    api A from Sales
    storage pg { type: postgres }
    resource salesState { for: Sales, kind: state, use: pg }
    deployable api { platform: dotnet  contexts: [Sales]  dataSources: [salesState]  serves: A  port: 8080 }
  }
`;

describe(".NET workflow VO param — namespace + Request DTO", () => {
  it("global::-anchors the AppDbContext in a transactional handler (no Api.Api doubling)", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const handler = [...files.entries()].find(([k]) =>
      k.endsWith("Application/Workflows/RecordPaymentHandler.cs"),
    )?.[1];
    expect(handler, "command handler not emitted").toBeDefined();
    // The injected DbContext is global::-anchored — both field + ctor param.
    expect(handler).toContain(
      "private readonly global::Api.Infrastructure.Persistence.AppDbContext _db;",
    );
    expect(handler).toContain("global::Api.Infrastructure.Persistence.AppDbContext db");
    // No bare reference survives (the leading `Api` would mis-resolve to `Api.Api`).
    expect(handler).not.toMatch(/(?<!global::)\bApi\.Infrastructure\.Persistence\.AppDbContext/);
  });

  it("emits the MoneyRequest VO request DTO for the workflow param", async () => {
    const files = (await generateSystems(await parseValid(SRC))).files;
    const voReqs = [...files.entries()].find(([k]) =>
      k.endsWith("Application/Workflows/WorkflowRequests.cs"),
    )?.[1];
    expect(voReqs, "WorkflowRequests.cs not emitted").toBeDefined();
    expect(voReqs).toContain("namespace Api.Application.Workflows;");
    expect(voReqs).toContain("public sealed record MoneyRequest(");
    // The workflow Request DTO references it unqualified — now resolvable in
    // its own `Application.Workflows` namespace.
    const req = [...files.entries()].find(([k]) =>
      k.endsWith("Application/Workflows/RecordPaymentRequest.cs"),
    )?.[1];
    expect(req).toContain("MoneyRequest Payment");
  });
});
