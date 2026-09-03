import { describe, expect, it } from "vitest";
import { dedupeByName } from "../../src/util/dedupe.js";

// `dedupeByName` (src/util/dedupe.ts) has exactly two documented properties:
// FIRST-WINS and ORDER-PRESERVING.  Both are load-bearing — it collapses the
// ambient root-level enums / value objects that enrichment folds into every
// hosted context of a multi-context backend deployable, and the surviving
// declaration is the one the bundler sees.  A "simplification" to
// `[...new Map(items.map((i) => [i.name, i])).values()]` keeps the ORDER but
// silently inverts the winner to LAST — which is why first-wins is asserted
// on a payload whose duplicates are distinguishable, not just on the names.

interface Named {
  name: string;
  tag: string;
}

const n = (name: string, tag: string): Named => ({ name, tag });

describe("dedupeByName — first-wins", () => {
  it("keeps the FIRST occurrence of each duplicate name and drops later ones", () => {
    const out = dedupeByName([n("a", "first"), n("b", "b1"), n("a", "second")]);
    expect(out.map((x) => x.name)).toEqual(["a", "b"]);
    // The distinguishing assertion: a Map-based rewrite would yield "second".
    expect(out[0]!.tag).toBe("first");
  });

  it("returns the very same object identity as the first occurrence", () => {
    const first = n("a", "first");
    const later = n("a", "second");
    const out = dedupeByName([first, later]);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(first);
    expect(out[0]).not.toBe(later);
  });

  it("keeps the first of a run of three or more with the same name", () => {
    const out = dedupeByName([n("x", "1"), n("x", "2"), n("x", "3")]);
    expect(out).toHaveLength(1);
    expect(out[0]!.tag).toBe("1");
  });
});

describe("dedupeByName — order preservation", () => {
  it("preserves the input order of the survivors", () => {
    const out = dedupeByName([
      n("c", "c1"),
      n("a", "a1"),
      n("b", "b1"),
      n("a", "a2"),
      n("c", "c2"),
      n("d", "d1"),
    ]);
    // Survivor order follows FIRST-occurrence order, not sorted order.
    expect(out.map((x) => x.name)).toEqual(["c", "a", "b", "d"]);
    expect(out.map((x) => x.tag)).toEqual(["c1", "a1", "b1", "d1"]);
  });

  it("does not reorder an all-unique input (it is the identity on names)", () => {
    const items = [n("z", "1"), n("m", "2"), n("a", "3")];
    const out = dedupeByName(items);
    expect(out.map((x) => x.name)).toEqual(["z", "m", "a"]);
    expect(out).toEqual(items);
  });
});

describe("dedupeByName — degenerate inputs", () => {
  it("returns an empty array for empty input", () => {
    expect(dedupeByName([])).toEqual([]);
  });

  it("returns a NEW array, never the input array itself (no aliasing)", () => {
    const items = [n("a", "1")];
    const out = dedupeByName(items);
    expect(out).not.toBe(items);
    expect(out).toEqual(items);
  });

  it("does not mutate its (readonly) input", () => {
    const items = [n("a", "1"), n("a", "2")];
    dedupeByName(items);
    expect(items).toHaveLength(2);
  });

  it("treats names as case-sensitive and exact (no normalisation)", () => {
    const out = dedupeByName([n("Order", "1"), n("order", "2"), n("Order ", "3")]);
    expect(out.map((x) => x.name)).toEqual(["Order", "order", "Order "]);
  });

  it("handles the empty-string name like any other name", () => {
    const out = dedupeByName([n("", "1"), n("", "2"), n("a", "3")]);
    expect(out.map((x) => x.tag)).toEqual(["1", "3"]);
  });
});
