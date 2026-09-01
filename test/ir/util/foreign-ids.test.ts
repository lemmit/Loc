import { describe, expect, it } from "vitest";
import type { TypeIR, WorkflowIR } from "../../../src/ir/types/loom-ir.js";
import { foreignIdBrandNames, workflowIdTypeSources } from "../../../src/ir/util/foreign-ids.js";

// Foreign id brands — the id types a deployable REFERENCES but does not HOST,
// so it must declare the brand itself.  M-T9.17 slice 5 — no test calls either
// export today.
//
// The module's header names the bug it was factored out of: the same collection
// was written four times (hono, python, dotnet, java) and all four drew from
// only TWO sources — foreign consumed-event fields and workflow STATE fields.
// None covered workflow STARTER PARAMS, so `create(orderId: Order id)` on a
// deployable that doesn't host `Order` emitted a reference to a brand that was
// never declared.  Every one of those backends produced code that failed its
// own compiler, and no vitest-tier gate saw it: the model is valid and every
// emitter "succeeds".
//
// A missing SOURCE is therefore the failure mode to test for, and it is why the
// two arms of `workflowIdTypeSources` are asserted SEPARATELY — a collector
// that kept only `stateFields` would still pass any test that supplies both.

const idT = (targetName: string): TypeIR =>
  ({ kind: "id", targetName, valueType: "guid" }) as unknown as TypeIR;
const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;

const wf = (over: Partial<WorkflowIR> = {}): WorkflowIR =>
  ({ name: "Fulfil", stateFields: [], creates: [], ...over }) as unknown as WorkflowIR;

const stateOnly = wf({
  stateFields: [{ name: "orderId", type: idT("Order") }],
} as unknown as Partial<WorkflowIR>);

const paramsOnly = wf({
  creates: [{ name: "start", params: [{ name: "orderId", type: idT("Order") }] }],
} as unknown as Partial<WorkflowIR>);

describe("workflowIdTypeSources — every position an id can be named", () => {
  it("collects nothing from a workflow with neither state nor creates", () => {
    expect(workflowIdTypeSources([wf()])).toEqual([]);
    expect(workflowIdTypeSources([])).toEqual([]);
  });

  it("collects persisted STATE field types", () => {
    expect(workflowIdTypeSources([stateOnly])).toEqual([idT("Order")]);
  });

  it("collects workflow STARTER PARAM types — the source all four copies missed", () => {
    // `create(orderId: Order id)`.  This arm asserted alone is the whole point
    // of the file: with it dropped, the deployable emits a reference to an
    // undeclared brand and fails its own compiler, while the toolchain reports
    // success.
    expect(workflowIdTypeSources([paramsOnly])).toEqual([idT("Order")]);
  });

  it("collects from BOTH arms, and across several workflows", () => {
    const got = workflowIdTypeSources([stateOnly, paramsOnly]);
    expect(got).toHaveLength(2);
  });

  it("collects EVERY create's params, not just the first", () => {
    const two = wf({
      creates: [
        { name: "a", params: [{ name: "o", type: idT("Order") }] },
        { name: "b", params: [{ name: "c", type: idT("Customer") }] },
      ],
    } as unknown as Partial<WorkflowIR>);
    expect(workflowIdTypeSources([two])).toEqual([idT("Order"), idT("Customer")]);
  });

  it("tolerates a MISSING stateFields array", () => {
    const bare = { name: "W", creates: [] } as unknown as WorkflowIR;
    expect(workflowIdTypeSources([bare])).toEqual([]);
  });

  it("returns types verbatim — non-id types are filtered later, not here", () => {
    // The split matters: this half is "every position", the other half is
    // "which of those are foreign ids".  Filtering early would make a new
    // source position silently unable to contribute a non-id type it should.
    const mixed = wf({
      stateFields: [{ name: "note", type: prim("string") }],
    } as unknown as Partial<WorkflowIR>);
    expect(workflowIdTypeSources([mixed])).toEqual([prim("string")]);
  });
});

describe("foreignIdBrandNames — which of those the deployable must declare", () => {
  const none = new Set<string>();

  it("is empty for no sources", () => {
    expect(foreignIdBrandNames(none, [])).toEqual([]);
  });

  it("keeps an id whose aggregate is NOT hosted", () => {
    expect(foreignIdBrandNames(none, [idT("Order")])).toEqual(["Order"]);
  });

  it("drops an id whose aggregate IS hosted — the deployable already declares it", () => {
    // A duplicate brand declaration is a compile error in the generated
    // project, so the hosted filter is as load-bearing as the collection.
    expect(foreignIdBrandNames(new Set(["Order"]), [idT("Order")])).toEqual([]);
  });

  it("ignores non-id types entirely", () => {
    expect(foreignIdBrandNames(none, [prim("string"), prim("int")])).toEqual([]);
  });

  it("DEDUPLICATES a brand referenced from several positions", () => {
    // The same foreign id typically appears in both a state field and a starter
    // param; emitting the brand twice would not compile.
    expect(foreignIdBrandNames(none, [idT("Order"), idT("Order"), idT("Order")])).toEqual([
      "Order",
    ]);
  });

  it("keeps distinct brands, in first-seen order", () => {
    expect(foreignIdBrandNames(none, [idT("Order"), idT("Customer"), idT("Order")])).toEqual([
      "Order",
      "Customer",
    ]);
  });

  it("filters per-name, not all-or-nothing", () => {
    expect(foreignIdBrandNames(new Set(["Order"]), [idT("Order"), idT("Customer")])).toEqual([
      "Customer",
    ]);
  });

  it("composes with the collector end to end — a starter param yields a brand", () => {
    // The regression, spelled as one assertion: a workflow whose ONLY foreign
    // id reference is a starter param must still produce the brand.
    expect(foreignIdBrandNames(none, workflowIdTypeSources([paramsOnly]))).toEqual(["Order"]);
  });
});
