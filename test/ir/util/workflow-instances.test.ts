import { describe, expect, it } from "vitest";
import type { WireField, WorkflowIR } from "../../../src/ir/types/loom-ir.js";
import {
  workflowCorrIdValueType,
  workflowCorrWireField,
} from "../../../src/ir/util/workflow-instances.js";

// The correlation field on an observable workflow's `instanceWireShape`, and
// the value type that drives `/instances/{id}`'s path-param schema on EVERY
// backend.  M-T9.17 slice 5 — no test calls either export today.
//
// The cross-backend claim in the module header is what makes this worth
// pinning: guid → uuid-format string, int/long → integer, string → plain
// string, derived ONCE so the parity gate's path-param dimension agrees by
// construction rather than by five emitters happening to choose alike
// (docs/old/plans/non-guid-id-http-params.md).  A wrong answer here is a schema
// that rejects a legal id, or accepts an illegal one, identically on all five.

const idType = (valueType: string, targetName = "Order") =>
  ({ kind: "id", targetName, valueType }) as never;

const wireField = (over: Partial<WireField> = {}): WireField =>
  ({ name: "orderId", source: "id", type: idType("guid"), ...over }) as unknown as WireField;

const wf = (shape: WireField[] | undefined): WorkflowIR =>
  ({ name: "Fulfil", instanceWireShape: shape }) as unknown as WorkflowIR;

describe('workflowCorrWireField — the `source: "id"` row', () => {
  it("returns the id-sourced field", () => {
    const corr = wireField();
    expect(workflowCorrWireField(wf([corr]))).toBe(corr);
  });

  it("picks it out from among other wire rows, whatever its position", () => {
    // Selection is by `source`, not by index — a positional read would pick the
    // wrong column the moment a workflow declares state before its correlation.
    const corr = wireField({ name: "correlation" });
    const shape = [
      wireField({ name: "status", source: "state", type: idType("guid") }),
      corr,
      wireField({ name: "step", source: "state", type: idType("guid") }),
    ];
    expect(workflowCorrWireField(wf(shape))).toBe(corr);
  });

  it("THROWS, naming the workflow, when no row is id-sourced", () => {
    // Every observable workflow has one by construction, so the absence is a
    // pipeline bug — loud beats a silently wrong path param.
    expect(() => workflowCorrWireField(wf([wireField({ source: "state" })]))).toThrow(/'Fulfil'/);
  });

  it("throws for an empty shape and for a MISSING one", () => {
    expect(() => workflowCorrWireField(wf([]))).toThrow();
    expect(() => workflowCorrWireField(wf(undefined))).toThrow();
  });
});

describe("workflowCorrIdValueType — the path-param schema, shared by five backends", () => {
  const withType = (type: unknown) => wf([wireField({ type: type as never })]);

  it("reads each id value type through", () => {
    for (const vt of ["guid", "int", "long", "string"]) {
      expect(workflowCorrIdValueType(withType(idType(vt))), vt).toBe(vt);
    }
  });

  it("unwraps ONE optional level", () => {
    // The correlation field can lower as `optional(id)`; reading the wrapper
    // directly would fall to the `guid` default and emit a uuid-format schema
    // for, say, a `long` id — rejecting every legal value.
    expect(workflowCorrIdValueType(withType({ kind: "optional", inner: idType("long") }))).toBe(
      "long",
    );
  });

  it("falls back to `guid` when the field is not id-typed", () => {
    // A conservative default rather than a throw: the field exists (the throw
    // above covers absence), and guid is the overwhelmingly common shape.
    expect(workflowCorrIdValueType(withType({ kind: "primitive", name: "string" }))).toBe("guid");
  });

  it("falls back to `guid` for an optional non-id, not to the inner primitive", () => {
    expect(
      workflowCorrIdValueType(
        withType({ kind: "optional", inner: { kind: "primitive", name: "string" } }),
      ),
    ).toBe("guid");
  });

  it("propagates the throw when there is no correlation row", () => {
    // Derived from `workflowCorrWireField`, so the two cannot disagree about
    // which row they are reading.
    expect(() => workflowCorrIdValueType(wf([]))).toThrow(/'Fulfil'/);
  });
});
