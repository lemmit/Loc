import { describe, expect, it } from "vitest";
import type { EditError, EditResult } from "../../src/api/index.js";
import { quickfix, rename, unfoldMacro } from "../../src/api/index.js";

// ---------------------------------------------------------------------------
// Navigational rewrite trio (agent-tools-and-mcp.md §4b) — rename / quickfix /
// unfold_macro RETURN edits, never apply them.  Applying the edits to the
// source reproduces the expected refactor; the providers themselves are tested
// in test/language/lsp/*, so this covers the by-name addressing + edit shaping.
// ---------------------------------------------------------------------------

function isError(r: EditResult | EditError): r is EditError {
  return "error" in r;
}

/** Apply contract edits (highest offset first) to reproduce the result text. */
function apply(source: string, edits: EditResult["edits"]): string {
  const lines = source.split("\n");
  const offsetAt = (p: { line: number; character: number }) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  const resolved = edits
    .map((e) => ({ start: offsetAt(e.range.start), end: offsetAt(e.range.end), text: e.newText }))
    .sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of resolved) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

describe("rename", () => {
  const SRC = `context Sales {
  aggregate Order {
    customerId: string
    function ownerId(): string = this.customerId
  }
}`;

  it("returns edits for the declaration and member-access use sites", async () => {
    const r = await rename(SRC, "Order.customerId", "ownerKey");
    if (isError(r)) throw new Error("expected edits");
    expect(r.edits.length).toBe(2);
    const out = apply(SRC, r.edits);
    expect(out).toContain("ownerKey: string");
    expect(out).toContain("this.ownerKey");
    expect(out).not.toMatch(/\bcustomerId\b/);
  });

  it("renames an aggregate (and its `X id` cross-refs) by name", async () => {
    const src = `context Sales {
  aggregate Order { total: int }
  aggregate Cart { primaryOrder: Order id }
}`;
    const r = await rename(src, "Order", "Sale");
    if (isError(r)) throw new Error("expected edits");
    const out = apply(src, r.edits);
    expect(out).toContain("aggregate Sale {");
    expect(out).toContain("Sale id");
  });

  it("propagates not-found for an unknown symbol", async () => {
    expect(await rename(SRC, "Ghost", "X")).toEqual({ error: "not-found", candidates: [] });
  });
});

describe("quickfix", () => {
  const BARE = `context Sales {
  aggregate Order { customer: Customer }
  aggregate Customer { name: string }
}`;

  it("returns the fix-hint edits for a diagnostic code", async () => {
    const r = await quickfix(BARE, "loom.bare-aggregate-in-type");
    if (isError(r)) throw new Error("expected edits");
    expect(r.title).toBeDefined();
    const out = apply(BARE, r.edits);
    expect(out).toContain("customer: Customer id");
  });

  it("reports not-found for a code with no matching diagnostic", async () => {
    const clean = `context Sales {
  aggregate Order { total: int }
}`;
    expect(await quickfix(clean, "loom.bare-aggregate-in-type")).toMatchObject({
      error: "not-found",
    });
  });

  it("reports no-fix for a diagnostic code that carries no fix-hint", async () => {
    // A parse error has a code but no fix-hint patch.
    const broken = `context Sales {
  aggregate Order { primary: Customer }
}`;
    const r = await quickfix(broken, "loom.parse-error");
    // either no-fix (matched, no hint) or ambiguous (several parse errors) —
    // both are structured errors, never a silent empty edit.
    expect(isError(r)).toBe(true);
  });
});

describe("unfoldMacro", () => {
  const SRC = `context Sales {
  aggregate Order with crudish { total: int }
}`;

  it("returns the unfold edits for a macro on a host", async () => {
    const r = await unfoldMacro(SRC, "crudish", "Order");
    if (isError(r)) throw new Error("expected edits");
    expect(r.edits.length).toBeGreaterThan(0);
    expect(r.title).toContain("crudish");
    // applying the unfold must keep the source parseable — the macro name is
    // gone from the `with` clause.
    const out = apply(SRC, r.edits);
    expect(out).not.toMatch(/with crudish/);
  });

  it("reports not-found with the macros the host does carry", async () => {
    expect(await unfoldMacro(SRC, "audit", "Order")).toMatchObject({
      error: "not-found",
      candidates: ["crudish"],
    });
  });

  it("propagates not-found for an unknown host symbol", async () => {
    expect(await unfoldMacro(SRC, "crudish", "Ghost")).toEqual({
      error: "not-found",
      candidates: [],
    });
  });
});
