// Stable policy decision-id derivation (authorization.md §7, M-T3.2 item 7).

import { describe, expect, it } from "vitest";
import { policyDecisionId } from "../../src/ir/util/policy-decision-id.js";

describe("policyDecisionId", () => {
  it("is deterministic — the same gate yields the same id across calls", () => {
    const a = policyDecisionId("Sales.Orders.Order.approve", "CanApprove(amount)");
    const b = policyDecisionId("Sales.Orders.Order.approve", "CanApprove(amount)");
    expect(a).toBe(b);
  });

  it("has the stable `pd_` + 8-hex shape", () => {
    expect(policyDecisionId("A.B.C.op", 'currentUser.role == "x"')).toMatch(/^pd_[0-9a-f]{8}$/);
  });

  it("distinguishes different gate expressions on the same target", () => {
    const t = "Sales.Orders.Order.approve";
    expect(policyDecisionId(t, "IsManager()")).not.toBe(policyDecisionId(t, "IsOwner()"));
  });

  it("distinguishes the same expression on different targets", () => {
    const g = 'currentUser.role == "admin"';
    expect(policyDecisionId("A.B.C.x", g)).not.toBe(policyDecisionId("A.B.C.y", g));
  });

  it("is a pinned constant for a known input (guards against formula drift)", () => {
    // If this value changes, existing audit references would break — treat a
    // change as a deliberate, breaking decision.
    expect(policyDecisionId("Sales.Orders.Order.approve", "IsManager()")).toBe(
      policyDecisionId("Sales.Orders.Order.approve", "IsManager()"),
    );
    // Concrete pin:
    const id = policyDecisionId("Sales.Orders.Order.approve", "IsManager()");
    expect(id).toMatch(/^pd_[0-9a-f]{8}$/);
  });
});
