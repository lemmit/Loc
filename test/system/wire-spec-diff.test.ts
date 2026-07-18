import { describe, expect, it } from "vitest";
import type { EnrichedSystemIR } from "../../src/ir/types/loom-ir.js";
import { buildWireSpec } from "../../src/system/wire-spec.js";
import { diffWireSpec, renderWireContractDiff } from "../../src/system/wire-spec-diff.js";
import { buildLoomModel } from "../_helpers/index.js";

// ---------------------------------------------------------------------------
// Diffs REAL `WireSpecDoc`s (built via `buildWireSpec` from two lowered +
// enriched systems) rather than hand-mocked JSON, so the classifier is pinned
// to the actual artifact shape.  Each case is a minimal `.ddd` pair whose only
// difference is the one edit under test.
// ---------------------------------------------------------------------------

async function specFor(ddd: string) {
  const loom = await buildLoomModel(ddd);
  const sys = loom.systems[0] as EnrichedSystemIR;
  return buildWireSpec(sys);
}

const sys = (body: string) => `
system S {
  subdomain D {
    context Sales {
      ${body}
    }
  }
  storage pg { type: postgres }
  resource salesState { for: Sales, kind: state, use: pg, schema: "sales" }
  deployable api { platform: node contexts: [Sales] dataSources: [salesState] port: 3000 }
}`;

const order = (fields: string) =>
  sys(`aggregate Order { ${fields} }  repository Orders for Order { }`);

describe("diffWireSpec", () => {
  it("reports no changes (non-breaking) for an identical spec", async () => {
    const a = await specFor(order("total: int  note: string"));
    const b = await specFor(order("total: int  note: string"));
    const diff = diffWireSpec(a, b);
    expect(diff.changes).toEqual([]);
    expect(diff.breaking).toBe(false);
  });

  it("a new OPTIONAL property is non-breaking", async () => {
    const a = await specFor(order("total: int"));
    const b = await specFor(order("total: int  note: string?"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(false);
    const added = diff.changes.find((c) => c.field === "note");
    expect(added?.kind).toBe("property-added-optional");
    expect(added?.breaking).toBe(false);
  });

  it("a new REQUIRED property is breaking", async () => {
    const a = await specFor(order("total: int"));
    const b = await specFor(order("total: int  note: string"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(true);
    const added = diff.changes.find((c) => c.field === "note");
    expect(added?.kind).toBe("property-added-required");
    expect(added?.breaking).toBe(true);
  });

  it("removing a property is breaking", async () => {
    const a = await specFor(order("total: int  note: string"));
    const b = await specFor(order("total: int"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(true);
    const removed = diff.changes.find((c) => c.field === "note");
    expect(removed?.kind).toBe("property-removed");
    expect(removed?.breaking).toBe(true);
  });

  it("removing an entire aggregate is breaking", async () => {
    const a = await specFor(
      sys(`
      aggregate Order { total: int }  repository Orders for Order { }
      aggregate Ticket { subject: string }  repository Tickets for Ticket { }`),
    );
    const b = await specFor(order("total: int"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(true);
    const removed = diff.changes.find((c) => c.entity === "Ticket");
    expect(removed?.kind).toBe("entity-removed");
    expect(removed?.bucket).toBe("aggregates");
    expect(removed?.breaking).toBe(true);
  });

  it("adding a new aggregate is non-breaking", async () => {
    const a = await specFor(order("total: int"));
    const b = await specFor(
      sys(`
      aggregate Order { total: int }  repository Orders for Order { }
      aggregate Ticket { subject: string }  repository Tickets for Ticket { }`),
    );
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(false);
    const added = diff.changes.find((c) => c.entity === "Ticket");
    expect(added?.kind).toBe("entity-added");
    expect(added?.breaking).toBe(false);
  });

  it("changing a property's type is breaking", async () => {
    const a = await specFor(order("total: int"));
    const b = await specFor(order("total: string"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(true);
    const changed = diff.changes.find((c) => c.field === "total");
    expect(changed?.kind).toBe("property-type-changed");
    expect(changed?.from).toBe("integer");
    expect(changed?.to).toBe("string");
    expect(changed?.breaking).toBe(true);
  });

  it("tightening an optional property to required is breaking", async () => {
    const a = await specFor(order("total: int  note: string?"));
    const b = await specFor(order("total: int  note: string"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(true);
    const change = diff.changes.find((c) => c.kind === "property-made-required");
    expect(change?.field).toBe("note");
    expect(change?.breaking).toBe(true);
  });

  it("relaxing a required property to optional is non-breaking", async () => {
    const a = await specFor(order("total: int  note: string"));
    const b = await specFor(order("total: int  note: string?"));
    const diff = diffWireSpec(a, b);
    expect(diff.breaking).toBe(false);
    const change = diff.changes.find((c) => c.kind === "property-made-optional");
    expect(change?.field).toBe("note");
    expect(change?.breaking).toBe(false);
  });

  it("rolls .breaking up from the change list", async () => {
    const a = await specFor(order("total: int"));
    const b = await specFor(order("total: int  note: string?  amount: money"));
    const diff = diffWireSpec(a, b);
    // Two additions: one optional (non-breaking), one required (breaking).
    expect(diff.changes.length).toBeGreaterThanOrEqual(2);
    expect(diff.breaking).toBe(diff.changes.some((c) => c.breaking));
    expect(diff.breaking).toBe(true);
  });

  it("renderWireContractDiff summarises the diff without a template engine", async () => {
    const a = await specFor(order("total: int"));
    const b = await specFor(order("total: int  note: string"));
    const text = renderWireContractDiff(diffWireSpec(a, b));
    expect(text).toContain("BREAKING");
    expect(text).toContain("note");
    const clean = renderWireContractDiff(diffWireSpec(a, a));
    expect(clean).toBe("No wire-contract changes.\n");
  });
});
