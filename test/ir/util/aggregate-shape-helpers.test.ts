import { describe, expect, it } from "vitest";
import type { AggregateIR, TypeIR } from "../../../src/ir/types/loom-ir.js";
import {
  aggregateFileField,
  aggregateHasFileField,
  typeIsFile,
} from "../../../src/ir/util/file-field.js";
import { aggregateIsVersioned } from "../../../src/ir/util/versioned-capability.js";

// Two capability/shape probes read off a resolved aggregate, each consulted by
// the validator AND the emitters.  M-T9.17 slice 5 — no test calls any of the
// four exports.
//
// `file-field`: a `File` is a wire-only leaf whose bytes live in an object
// store, so a File-bearing aggregate CONSTRAINS its host deployable (it must
// bind an `objectStore` dataSource — `validateFileFieldObjectStorage`) and makes
// the Hono backend emit the upload/download endpoints.  A false negative drops
// both the constraint and the endpoints, leaving a field with no way to carry
// its bytes.
//
// `versioned-capability`: the marker three separate emissions hang off — the
// `version INTEGER NOT NULL DEFAULT 1` column, the guarded
// `UPDATE ... WHERE id = $1 AND version = $2` write, and the 409 arm when that
// write affects zero rows.  A false negative there is a silent lost update.

const prim = (name: string): TypeIR => ({ kind: "primitive", name }) as TypeIR;
const arr = (element: TypeIR): TypeIR => ({ kind: "array", element });
const opt = (inner: TypeIR): TypeIR => ({ kind: "optional", inner });

const field = (name: string, type: TypeIR) => ({ name, type });

const agg = (over: Partial<AggregateIR> = {}): AggregateIR =>
  ({ name: "Order", fields: [], parts: [], capabilities: [], ...over }) as unknown as AggregateIR;

describe("typeIsFile — unwrapping the wrappers a File can wear", () => {
  it("is true for the bare `File` primitive", () => {
    expect(typeIsFile(prim("File"))).toBe(true);
  });

  it("unwraps an OPTIONAL — `File?`", () => {
    expect(typeIsFile(opt(prim("File")))).toBe(true);
  });

  it("unwraps an ARRAY — `File[]`", () => {
    // Each wrapper asserted alone: a probe handling only one of the two would
    // miss half the declarable shapes, and the miss is silent.
    expect(typeIsFile(arr(prim("File")))).toBe(true);
  });

  it("unwraps the wrappers in combination, either nesting order", () => {
    expect(typeIsFile(arr(opt(prim("File"))))).toBe(true);
    expect(typeIsFile(opt(arr(prim("File"))))).toBe(true);
  });

  it("is false for every other primitive, and for a wrapped one", () => {
    expect(typeIsFile(prim("string"))).toBe(false);
    expect(typeIsFile(arr(prim("string")))).toBe(false);
    expect(typeIsFile(opt(prim("json")))).toBe(false);
  });

  it("is false for a non-primitive type", () => {
    expect(typeIsFile({ kind: "valueobject", name: "Money" })).toBe(false);
    expect(typeIsFile({ kind: "entity", name: "Line" })).toBe(false);
  });
});

describe("aggregateFileField — which field, and where it lives", () => {
  it("is undefined for an aggregate with no File field", () => {
    expect(
      aggregateFileField(agg({ fields: [field("name", prim("string"))] } as never)),
    ).toBeUndefined();
    expect(aggregateFileField(agg())).toBeUndefined();
  });

  it("names a root field plainly", () => {
    expect(
      aggregateFileField(
        agg({ fields: [field("name", prim("string")), field("scan", prim("File"))] } as never),
      ),
    ).toBe("scan");
  });

  it("names a PART field as `<part>.<field>` — the arm a root-only scan drops", () => {
    // Asserted with the ROOT fields explicitly File-free, so it cannot pass on
    // the strength of the root arm.  The qualified name is what the diagnostic
    // shows the author.
    expect(
      aggregateFileField(
        agg({
          fields: [field("name", prim("string"))],
          parts: [{ name: "attachment", fields: [field("blob", prim("File"))] }],
        } as never),
      ),
    ).toBe("attachment.blob");
  });

  it("prefers a ROOT field over a part field when both exist", () => {
    // Root fields are scanned first; pinning the order keeps the reported field
    // stable rather than dependent on part ordering.
    expect(
      aggregateFileField(
        agg({
          fields: [field("scan", prim("File"))],
          parts: [{ name: "attachment", fields: [field("blob", prim("File"))] }],
        } as never),
      ),
    ).toBe("scan");
  });

  it("scans a LATER part, not just the first", () => {
    expect(
      aggregateFileField(
        agg({
          parts: [
            { name: "a", fields: [field("x", prim("string"))] },
            { name: "b", fields: [field("blob", prim("File"))] },
          ],
        } as never),
      ),
    ).toBe("b.blob");
  });

  it("finds a WRAPPED File on a part field too", () => {
    expect(
      aggregateFileField(
        agg({ parts: [{ name: "att", fields: [field("blobs", arr(prim("File")))] }] } as never),
      ),
    ).toBe("att.blobs");
  });
});

describe("aggregateHasFileField — the boolean face of the same question", () => {
  it("agrees with `aggregateFileField` in both directions", () => {
    // Defined as `aggregateFileField(agg) !== undefined`; pinning the agreement
    // keeps the two from splitting if either grows its own scan.
    const withFile = agg({ fields: [field("scan", prim("File"))] } as never);
    const without = agg({ fields: [field("name", prim("string"))] } as never);
    expect(aggregateHasFileField(withFile)).toBe(aggregateFileField(withFile) !== undefined);
    expect(aggregateHasFileField(without)).toBe(false);
  });

  it("is true from a part field alone", () => {
    expect(
      aggregateHasFileField(
        agg({ parts: [{ name: "att", fields: [field("blob", prim("File"))] }] } as never),
      ),
    ).toBe(true);
  });
});

describe("aggregateIsVersioned — the optimistic-concurrency marker", () => {
  it("is true when the aggregate declares `versioned`", () => {
    expect(aggregateIsVersioned(agg({ capabilities: ["versioned"] } as never))).toBe(true);
  });

  it("is true alongside other capabilities", () => {
    expect(
      aggregateIsVersioned(
        agg({ capabilities: ["auditable", "versioned", "tenantOwned"] } as never),
      ),
    ).toBe(true);
  });

  it("is false for an aggregate with other capabilities but not this one", () => {
    expect(aggregateIsVersioned(agg({ capabilities: ["auditable"] } as never))).toBe(false);
  });

  it("is false for an EMPTY capability list", () => {
    expect(aggregateIsVersioned(agg({ capabilities: [] } as never))).toBe(false);
  });

  it("is false — not undefined — when `capabilities` is MISSING", () => {
    // `?? false`.  The three emissions gate on this boolean directly; a
    // returned `undefined` would be falsy today and a silent type hole if any
    // caller ever compared it strictly.
    expect(aggregateIsVersioned({ name: "Order" } as unknown as AggregateIR)).toBe(false);
  });

  it("matches the capability name exactly", () => {
    expect(aggregateIsVersioned(agg({ capabilities: ["versionedSoft"] } as never))).toBe(false);
  });
});
