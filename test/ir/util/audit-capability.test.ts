import { describe, expect, it } from "vitest";
import type { AggregateIR, BoundedContextIR } from "../../../src/ir/types/loom-ir.js";
import {
  aggHasAuditedTarget,
  contextHasAuditedTarget,
} from "../../../src/ir/util/audit-capability.js";

// This predicate gates three separate emissions — the `audit_records` table
// DDL, the schema import into a route file, and the insert in the matching
// handler — so a false negative produces a project that records nothing and
// still compiles.  M-T9.17 slice 2 — no direct test.
//
// The three-arm shape is the whole point, and it is a REGRESSION the module's
// own header names: pre-#1503 each backend scanned only `agg.operations`, so
// audited CREATES and DESTROYS were silently dropped.  Each arm is therefore
// asserted alone — a copy that checked only `operations` would still pass a
// test that always supplies an audited operation.

const op = (audited: boolean) => ({ name: "act", audited });

const agg = (over: Partial<AggregateIR> = {}): AggregateIR =>
  ({ name: "Order", operations: [], creates: [], destroys: [], ...over }) as unknown as AggregateIR;

describe("aggHasAuditedTarget — one arm per command action", () => {
  it("is false when nothing is audited", () => {
    expect(
      aggHasAuditedTarget(
        agg({
          operations: [op(false)],
          creates: [op(false)],
          destroys: [op(false)],
        } as unknown as Partial<AggregateIR>),
      ),
    ).toBe(false);
  });

  it("fires on an audited OPERATION", () => {
    expect(
      aggHasAuditedTarget(agg({ operations: [op(true)] } as unknown as Partial<AggregateIR>)),
    ).toBe(true);
  });

  it("fires on an audited CREATE — the arm the pre-#1503 scan dropped", () => {
    expect(
      aggHasAuditedTarget(agg({ creates: [op(true)] } as unknown as Partial<AggregateIR>)),
    ).toBe(true);
  });

  it("fires on an audited DESTROY — the other dropped arm", () => {
    expect(
      aggHasAuditedTarget(agg({ destroys: [op(true)] } as unknown as Partial<AggregateIR>)),
    ).toBe(true);
  });

  it("tolerates MISSING creates/destroys arrays", () => {
    // `(agg.creates ?? [])` — an aggregate lowered without the optional arrays
    // must not throw, which is the difference between a presence gate and a
    // crash during emission.
    const bare = { name: "Order", operations: [] } as unknown as AggregateIR;
    expect(aggHasAuditedTarget(bare)).toBe(false);
  });

  it("is a `some` — one audited action among many unaudited is enough", () => {
    expect(
      aggHasAuditedTarget(
        agg({ operations: [op(false), op(false), op(true)] } as unknown as Partial<AggregateIR>),
      ),
    ).toBe(true);
  });
});

describe("contextHasAuditedTarget", () => {
  const ctx = (aggregates: AggregateIR[]): BoundedContextIR =>
    ({ name: "C", aggregates }) as unknown as BoundedContextIR;

  it("is false for an empty context and for an all-unaudited one", () => {
    expect(contextHasAuditedTarget(ctx([]))).toBe(false);
    expect(contextHasAuditedTarget(ctx([agg(), agg()]))).toBe(false);
  });

  it("is true when any aggregate carries an audited action", () => {
    const audited = agg({ destroys: [op(true)] } as unknown as Partial<AggregateIR>);
    expect(contextHasAuditedTarget(ctx([agg(), audited]))).toBe(true);
  });
});
