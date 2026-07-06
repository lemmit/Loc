// Named policy functions (authorization Phase 3.2) — parsing + lowering.
//
// A function-form `policy Name(params): bool` declaration is INLINED at every
// `requires PolicyName(args)` gate that references it (the criterion-inlining
// mechanism), with the call arguments substituted for the parameters.  It
// produces NO standalone IR node — the gate's `requires` statement carries the
// inlined boolean predicate directly, so every backend enforces it through the
// existing `requires` → 403 path.

import { describe, expect, it } from "vitest";
import { buildLoomModel } from "../_helpers/ir.js";

const system = (body: string) => `
  system Shop {
    user { id: string  role: string  permissions: string[] }
    subdomain Sales {
      permissions { approve, manage }
      context Orders {
        enum OrderStatus { Draft, Approved }
        policy CanApprove(cap: money): bool =
          currentUser.permissions.contains(permissions.approve) && cap <= 10000
        policy IsManager(): bool { currentUser.permissions.contains(permissions.manage) }
        aggregate Order {
          amount: money
          status: OrderStatus
          operation approve() {
            ${body}
            status := OrderStatus.Approved
          }
        }
        repository Orders for Order { }
      }
    }
    storage s { type: postgres }
    resource st { for: Orders, kind: state, use: s }
    deployable api { platform: node  contexts: [Orders]  dataSources: [st]  port: 8080  auth: required }
  }
`;

const orderOf = (model: Awaited<ReturnType<typeof buildLoomModel>>) =>
  model.systems[0]!.subdomains[0]!.contexts[0]!.aggregates.find((a) => a.name === "Order")!;

describe("named policy functions — lowering (inline at requires)", () => {
  it("inlines a parameterised policy-function call, substituting the argument", async () => {
    const model = await buildLoomModel(system("requires CanApprove(amount)"));
    const json = JSON.stringify(orderOf(model));
    // The predicate body is inlined: the resolved permission string, the
    // current-user ref, and the money literal all appear...
    expect(json).toContain("sales.approve");
    expect(json).toContain('"current-user"');
    expect(json).toContain("10000");
    // ...and there is NO dangling call to the policy-function name (it dissolved).
    expect(json).not.toContain('"name":"CanApprove"');
  });

  it("inlines a parameterless policy-function call `IsManager()`", async () => {
    const model = await buildLoomModel(system("requires IsManager()"));
    const json = JSON.stringify(orderOf(model));
    expect(json).toContain("sales.manage");
    expect(json).toContain('"current-user"');
    expect(json).not.toContain('"name":"IsManager"');
  });

  it("inlines a bare parameterless reference `requires IsManager`", async () => {
    const model = await buildLoomModel(system("requires IsManager"));
    const json = JSON.stringify(orderOf(model));
    expect(json).toContain("sales.manage");
    expect(json).not.toContain('"name":"IsManager"');
  });

  it("a policy-function reference composes under boolean operators", async () => {
    const model = await buildLoomModel(system("requires IsManager() && CanApprove(amount)"));
    const json = JSON.stringify(orderOf(model));
    expect(json).toContain("sales.manage");
    expect(json).toContain("sales.approve");
    expect(json).not.toContain('"name":"IsManager"');
    expect(json).not.toContain('"name":"CanApprove"');
  });

  it("a function-form policy declaration produces no read/write policy levels", async () => {
    const model = await buildLoomModel(system("requires CanApprove(amount)"));
    const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
    expect(ctx.policyReadLevels).toBeUndefined();
    expect(ctx.policyWriteLevels).toBeUndefined();
  });
});
