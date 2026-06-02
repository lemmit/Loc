// Workflow `on(e: Event) { … }` reactor validation (workflow-and-applier.md
// Phase A2, surface slice).  Covers the grammar-enforced "reactors are
// workflow-only" rule, event-binding resolution, and the
// `loom.on-duplicate-subscription` warning.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/index.js";

const ctx = (members: string): string => `
  system S { subdomain M { context C {
    aggregate Order { total: int }
    event PaymentReceived { order: Order id, amount: int }
    ${members}
  }}}`;

describe("workflow on(...) reactors — validation", () => {
  it("accepts a workflow with one on(...) reactor", async () => {
    const { errors } = await parseString(
      ctx(`workflow W() { on(paid: PaymentReceived) { let x = paid.amount } }`),
    );
    expect(errors).toEqual([]);
  });

  it("rejects an on(...) reactor outside a workflow (grammar-enforced)", async () => {
    // `on(...)` is only reachable from a workflow body; an aggregate-level
    // `on` is a parse error, not a semantic one (rule 7 is grammar-scoped).
    const { errors } = await parseString(ctx(`aggregate Bad { on(paid: PaymentReceived) { } }`));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("flags an unresolved event in on(bad: NoSuchEvent)", async () => {
    const { errors } = await parseString(ctx(`workflow W() { on(e: NoSuchEvent) { } }`));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("warns on two reactors for the same event (loom.on-duplicate-subscription)", async () => {
    const { diagnostics } = await parseString(
      ctx(`workflow W() {
        on(a: PaymentReceived) { let x = a.amount }
        on(b: PaymentReceived) { let y = b.amount }
      }`),
    );
    const warning = diagnostics.find((d) => d.code === "loom.on-duplicate-subscription");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe(2); // LSP DiagnosticSeverity.Warning
  });
});
