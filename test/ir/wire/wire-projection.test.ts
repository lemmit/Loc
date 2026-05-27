// Wire-projection filter unit tests — the 5×4 matrix of (FieldAccess
// × boundary) lives here as one canonical assertion table.  Backends
// import these filters and trust this test to catch any semantic
// drift.  See `src/ir/wire-projection.ts` for the rules under test.

import { describe, expect, it } from "vitest";
import {
  forApiRead,
  forCreateInput,
  forUiRead,
  forUpdateInput,
  updatePreconditions,
} from "../../../src/ir/enrich/wire-projection.js";
import type { FieldAccess, WireField } from "../../../src/ir/types/loom-ir.js";

// Synthetic wire field with one of each access role.  Names are
// deliberately the modifier itself for readability of failure
// messages.
function syntheticShape(): WireField[] {
  const access: FieldAccess[] = ["editable", "immutable", "managed", "token", "internal", "secret"];
  return access.map((a) => ({
    name: a,
    type: { kind: "primitive", name: "string" },
    optional: false,
    source: "property",
    access: a,
  }));
}

describe("wire-projection — per-boundary filters", () => {
  const wire = syntheticShape();

  // Authoritative table.  Read as: "for boundary X, access Y is
  // included? (true/false)".  Any future modifier or boundary must
  // extend this table before changing the filter helpers.
  const TABLE: Record<FieldAccess, Record<string, boolean>> = {
    editable: { apiRead: true, uiRead: true, createInput: true, updateInput: true },
    immutable: { apiRead: true, uiRead: true, createInput: true, updateInput: false },
    managed: { apiRead: true, uiRead: true, createInput: false, updateInput: false },
    token: { apiRead: true, uiRead: true, createInput: false, updateInput: false },
    internal: { apiRead: false, uiRead: true, createInput: false, updateInput: false },
    secret: { apiRead: false, uiRead: false, createInput: true, updateInput: true },
  };

  function names(fs: WireField[]): string[] {
    return fs.map((f) => f.name);
  }

  it("forApiRead matches the table (no internal, no secret)", () => {
    const got = names(forApiRead(wire));
    const expected = Object.entries(TABLE)
      .filter(([, m]) => m.apiRead)
      .map(([k]) => k);
    expect(got).toEqual(expected);
  });

  it("forUiRead matches the table (no secret; internal allowed)", () => {
    const got = names(forUiRead(wire));
    const expected = Object.entries(TABLE)
      .filter(([, m]) => m.uiRead)
      .map(([k]) => k);
    expect(got).toEqual(expected);
  });

  it("forCreateInput matches the table (immutable + secret allowed; managed/token/internal excluded)", () => {
    const got = names(forCreateInput(wire));
    const expected = Object.entries(TABLE)
      .filter(([, m]) => m.createInput)
      .map(([k]) => k);
    expect(got).toEqual(expected);
  });

  it("forUpdateInput matches the table (secret allowed; immutable/managed/token/internal excluded)", () => {
    const got = names(forUpdateInput(wire));
    const expected = Object.entries(TABLE)
      .filter(([, m]) => m.updateInput)
      .map(([k]) => k);
    expect(got).toEqual(expected);
  });

  it("updatePreconditions returns only token fields", () => {
    const got = names(updatePreconditions(wire));
    expect(got).toEqual(["token"]);
  });
});

describe("wire-projection — preserves field metadata", () => {
  it("returned WireFields are the same instances (not copies)", () => {
    const wire = syntheticShape();
    const filtered = forApiRead(wire);
    // Identity check: filter returns references into the input array,
    // not reconstructions.  Cheap; matters for downstream code that
    // associates per-field state via WeakMap or `===` lookup.
    for (const f of filtered) {
      expect(wire.includes(f)).toBe(true);
    }
  });

  it("source-tagged WireFields (id, containment, derived) flow through unchanged", () => {
    const wire: WireField[] = [
      {
        name: "id",
        type: { kind: "id", targetName: "Order", valueType: "guid" },
        optional: false,
        source: "id",
        access: "token",
      },
      {
        name: "lines",
        type: { kind: "array", element: { kind: "entity", name: "OrderLine" } },
        optional: false,
        source: "containment",
        access: "editable",
      },
      {
        name: "subtotal",
        type: { kind: "primitive", name: "money" },
        optional: false,
        source: "derived",
        access: "editable",
      },
    ];
    const apiRead = forApiRead(wire);
    expect(apiRead.map((f) => f.source)).toEqual(["id", "containment", "derived"]);
    expect(updatePreconditions(wire).map((f) => f.name)).toEqual(["id"]);
  });
});
