// Validator coverage for FUNCTION-form `policy` declarations + use sites
// (authorization Phase 3.2 — named, requires-gated authorization predicates).
// Diagnostic codes: loom.policy-fn-return-type, loom.policy-fn-arity,
// loom.policy-fn-cycle.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

const ctx = (body: string) => `
  system Shop {
    user { id: string  role: string  permissions: string[] }
    subdomain Sales {
      permissions { approve, manage }
      context Orders {
        enum OrderStatus { Draft, Approved }
        aggregate Order {
          amount: money
          status: OrderStatus
        }
        repository Orders for Order { }
        ${body}
      }
    }
    storage s { type: postgres }
    resource st { for: Orders, kind: state, use: s }
    deployable api { platform: node  contexts: [Orders]  dataSources: [st]  port: 8080  auth: required }
  }
`;

const codesOf = (diags: { code?: string }[]) =>
  diags.map((d) => d.code).filter((c): c is string => c !== undefined);

describe("validator — named policy functions", () => {
  it("accepts a parameterised and a parameterless bool policy function", async () => {
    const { errors } = await parseString(
      ctx(`
        policy CanApprove(cap: money): bool =
          currentUser.permissions.contains(permissions.approve) && cap <= 10000
        policy IsManager(): bool { currentUser.permissions.contains(permissions.manage) }
      `),
    );
    expect(errors).toEqual([]);
  });

  it("accepts composition of policy functions with && / || / !", async () => {
    const { errors } = await parseString(
      ctx(`
        policy IsManager(): bool = currentUser.permissions.contains(permissions.manage)
        policy CanApprove(cap: money): bool = IsManager() && cap <= 10000
      `),
    );
    expect(errors).toEqual([]);
  });

  it("rejects a non-bool return type (loom.policy-fn-return-type)", async () => {
    const { diagnostics, errors } = await parseString(ctx(`policy BadReturn(): string = "nope"`));
    expect(codesOf(diagnostics)).toContain("loom.policy-fn-return-type");
    expect(errors.join("\n")).toMatch(/must return 'bool'/);
  });

  it("rejects a wrong-arity call (loom.policy-fn-arity)", async () => {
    const { diagnostics } = await parseString(
      ctx(`
        policy NeedsArg(cap: money): bool = cap <= 10000
        policy Uses(): bool = NeedsArg()
      `),
    );
    expect(codesOf(diagnostics)).toContain("loom.policy-fn-arity");
  });

  it("rejects a parameterised policy function referenced bare (loom.policy-fn-arity)", async () => {
    const { diagnostics } = await parseString(
      ctx(`
        policy NeedsArg(cap: money): bool = cap <= 10000
        policy Uses(): bool = NeedsArg
      `),
    );
    expect(codesOf(diagnostics)).toContain("loom.policy-fn-arity");
  });

  it("rejects a policy-function reference cycle (loom.policy-fn-cycle)", async () => {
    const { diagnostics, errors } = await parseString(
      ctx(`
        policy A(): bool = B()
        policy B(): bool = A()
      `),
    );
    expect(codesOf(diagnostics)).toContain("loom.policy-fn-cycle");
    expect(errors.join("\n")).toMatch(/reference cycle/);
  });
});
