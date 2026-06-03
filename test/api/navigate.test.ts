import { describe, expect, it } from "vitest";
import type { NavError, NavSymbol } from "../../src/api/index.js";
import { findSymbol, hover, references } from "../../src/api/index.js";

// ---------------------------------------------------------------------------
// Navigational toolkit (agent-tools-and-mcp.md §4b) — by-name addressing over
// the LSP providers.  Covers the symbol resolver (short form, qualified form,
// kind filter, ambiguity, not-found) and the three read verbs.
// ---------------------------------------------------------------------------

const SRC = `context Sales {
  enum Status { Open, Closed }
  aggregate Order {
    customerId: string
    status: Status
    function ownerId(): string = this.customerId
    operation close() { status := Closed }
  }
  aggregate Cart { total: int }
}`;

function isError(r: unknown): r is NavError {
  return typeof r === "object" && r !== null && "error" in r;
}

describe("findSymbol", () => {
  it("resolves a qualified member path to its address, kind, range, and parent", async () => {
    const r = (await findSymbol(SRC, "Order.customerId")) as NavSymbol;
    expect(isError(r)).toBe(false);
    expect(r.address).toBe("aggregate Sales.Order.customerId");
    expect(r.kind).toBe("property");
    expect(r.parent).toBe("aggregate Sales.Order");
    // range points at the name token, not the whole declaration.
    expect(r.range.start.line).toBe(3);
  });

  it("resolves a short form when unambiguous", async () => {
    const r = (await findSymbol(SRC, "customerId")) as NavSymbol;
    expect(r.address).toBe("aggregate Sales.Order.customerId");
  });

  it("reports the node's own kind, not the address keyword", async () => {
    expect(((await findSymbol(SRC, "Order.close")) as NavSymbol).kind).toBe("operation");
    expect(((await findSymbol(SRC, "Order.ownerId")) as NavSymbol).kind).toBe("function");
    expect(((await findSymbol(SRC, "Order")) as NavSymbol).kind).toBe("aggregate");
  });

  it("disambiguates by kind", async () => {
    const r = (await findSymbol(SRC, "Order.status", "property")) as NavSymbol;
    expect(r.address).toBe("aggregate Sales.Order.status");
    // a kind that doesn't match the node is a miss, not a wrong pick.
    expect(await findSymbol(SRC, "Order", "property")).toEqual({
      error: "not-found",
      candidates: [],
    });
  });

  it("returns ambiguous with sorted candidates for a name shared across decls", async () => {
    // `total` is only on Cart here; add the ambiguity explicitly.
    const dup = `context Sales {
  aggregate Order { total: int }
  aggregate Cart { total: int }
}`;
    const r = await findSymbol(dup, "total");
    expect(r).toEqual({
      error: "ambiguous",
      candidates: ["aggregate Sales.Cart.total", "aggregate Sales.Order.total"],
    });
  });

  it("returns not-found for an unknown symbol", async () => {
    expect(await findSymbol(SRC, "Nope.field")).toEqual({ error: "not-found", candidates: [] });
  });
});

describe("references", () => {
  it("finds the declaration plus member-access use sites", async () => {
    const r = await references(SRC, "Order.customerId");
    if (isError(r)) throw new Error("expected locations");
    // declaration + `this.customerId` in ownerId().
    expect(r.locations.length).toBe(2);
    // sorted by position.
    expect(r.locations[0]!.range.start.line).toBeLessThanOrEqual(r.locations[1]!.range.start.line);
  });

  it("propagates an ambiguity error instead of guessing", async () => {
    const dup = `context Sales {
  aggregate Order { total: int }
  aggregate Cart { total: int }
}`;
    expect(await references(dup, "total")).toMatchObject({ error: "ambiguous" });
  });
});

describe("hover", () => {
  it("returns the aggregate hover bubble", async () => {
    const r = await hover(SRC, "Order");
    if (isError(r)) throw new Error("expected markdown");
    expect(r.markdown).toContain("aggregate Order");
  });

  it("returns the property signature for a member", async () => {
    const r = await hover(SRC, "Order.status");
    if (isError(r)) throw new Error("expected markdown");
    expect(r.markdown).toContain("status: Status");
  });

  it("propagates not-found", async () => {
    expect(await hover(SRC, "Ghost")).toEqual({ error: "not-found", candidates: [] });
  });
});
