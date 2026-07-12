// Carrier-bounded generic payloads (payload-transport-layer.md, P3a).
// Grammar surface — ML-postfix instantiation with the blessed keyword
// constructors (`paged`, `envelope`) — plus the soft-keyword admission that
// keeps pre-existing fields named `paged` / `envelope` parsing, and the
// AST-level carrier-bound validator.

import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import { parseRawOk, parseString } from "../../_helpers/parse.js";

const errorCodes = (diags: Diagnostic[]): (string | number | undefined)[] =>
  diags.filter((d) => d.severity === 1).map((d) => d.code);

describe("generics — grammar (P3a)", () => {
  it("parses a single postfix carrier on a primitive (`string paged`)", () => {
    expect(parseRawOk(`context C { valueobject V { items: string paged } }`)).toBe(true);
  });

  it("parses a postfix carrier on an `X id` base (`Customer id paged`)", () => {
    expect(
      parseRawOk(`context C {
        aggregate Customer { name: string }
        valueobject V { refs: Customer id paged }
      }`),
    ).toBe(true);
  });

  it("parses `envelope` as a carrier (`string envelope`)", () => {
    expect(parseRawOk(`context C { valueobject V { e: string envelope } }`)).toBe(true);
  });

  it("parses array-outside-carrier (`string paged[]`)", () => {
    expect(parseRawOk(`context C { valueobject V { pages: string paged[] } }`)).toBe(true);
  });

  it("parses chained constructors (`string envelope paged`)", () => {
    // Grammar admits nesting (forward-compatible); the carrier-bound
    // validator restricts it in v1 — see the validator suite below.
    expect(parseRawOk(`context C { valueobject V { x: string envelope paged } }`)).toBe(true);
  });
});

describe("generics — soft-keyword admission (P3a)", () => {
  it("still allows a field named `paged`", () => {
    expect(parseRawOk(`context C { valueobject V { paged: int } }`)).toBe(true);
  });

  it("still allows a field named `envelope`", () => {
    expect(parseRawOk(`context C { valueobject V { envelope: string } }`)).toBe(true);
  });

  it("allows a `paged`-named field after an optional/array-suffixed field", () => {
    // The postfix ctor loop sits *before* the `?` / `[]` suffix, so an
    // optional-suffixed field cleanly terminates and the next `paged` token
    // is read as a new member name.
    expect(parseRawOk(`context C { valueobject V { a: int? paged: string } }`)).toBe(true);
    expect(parseRawOk(`context C { valueobject V { a: int[] envelope: string } }`)).toBe(true);
  });

  it("documents the one ambiguous position: a bare-type field directly before `paged`", () => {
    // `a: int paged: ...` greedily reads `paged` as a carrier on `int`
    // (`paged(int)`), then chokes on the `:` — the accepted, narrow cost of
    // keyword-postfix instantiation (see the P3 plan's load-bearing decision).
    // Adding an `?`/`[]` suffix or reordering avoids it.
    expect(parseRawOk(`context C { valueobject V { a: int paged: string } }`)).toBe(false);
  });
});

describe("generics — carrier-bound validator (P3a)", () => {
  it("rejects nested carriers (`string envelope paged`) with loom.generic-arg-not-carrier", async () => {
    const { diagnostics } = await parseString(
      `context C { valueobject V { x: string envelope paged } }`,
    );
    expect(errorCodes(diagnostics)).toContain("loom.generic-arg-not-carrier");
  });

  it("accepts a single carrier in a transport position (payload field)", async () => {
    const { diagnostics } = await parseString(`context C { response R { items: string paged } }`);
    expect(errorCodes(diagnostics)).not.toContain("loom.generic-arg-not-carrier");
    expect(errorCodes(diagnostics)).not.toContain("loom.generic-position");
  });
});

describe("generics — position restriction (P3b)", () => {
  it("allows a carrier as a payload field", async () => {
    const { diagnostics } = await parseString(`context C { response R { items: string paged } }`);
    expect(errorCodes(diagnostics)).not.toContain("loom.generic-position");
  });

  it("allows a carrier as a repository find return", async () => {
    const { diagnostics } = await parseString(`context C {
      aggregate Order { ref: string }
      repository Orders for Order { find recent(): Order id paged }
    }`);
    expect(errorCodes(diagnostics)).not.toContain("loom.generic-position");
  });

  it("rejects a carrier as a stored aggregate/value-object field (loom.generic-position)", async () => {
    const { diagnostics } = await parseString(
      `context C { valueobject V { items: string paged } }`,
    );
    expect(errorCodes(diagnostics)).toContain("loom.generic-position");
  });

  it("rejects a carrier as a find parameter", async () => {
    const { diagnostics } = await parseString(`context C {
      aggregate Order { ref: string }
      repository Orders for Order { find weird(p: string paged): Order[] }
    }`);
    expect(errorCodes(diagnostics)).toContain("loom.generic-position");
  });
});
