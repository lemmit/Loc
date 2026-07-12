// Discriminated-union surface (payload-transport-layer.md, P4) — parsing.
//
// Covers the two union surfaces (anonymous `A or B` in a type position; named
// `payload Foo = A | B`), the `option` postfix carrier, the postfix-binds-
// tighter-than-`or` precedence pin, and the soft-keyword admission that keeps
// pre-existing fields named `or` / `option` parsing.

import type { Diagnostic } from "langium";
import { describe, expect, it } from "vitest";
import {
  isNamedType,
  isPayloadDecl,
  isPrimitiveType,
  isTypeAtom,
} from "../../../src/language/generated/ast.js";
import { parseRaw, parseRawOk, parseString } from "../../_helpers/parse.js";

const errorCodes = (diags: Diagnostic[]): (string | number | undefined)[] =>
  diags.filter((d) => d.severity === 1).map((d) => d.code);

/** The single find's return TypeRef in a one-repository context. */
function findReturn(src: string) {
  const model = parseRaw(src);
  const ctx = model.members.find((m) => m.$type === "BoundedContext") as never;
  const repo = (ctx as { members: { $type: string; finds?: unknown[] }[] }).members.find(
    (m) => m.$type === "Repository",
  ) as { finds: { returnType: unknown }[] };
  return repo.finds[0]!.returnType as import("../../../src/language/generated/ast.js").TypeRef;
}

const REPO = (ret: string): string => `
  context C {
    aggregate Order { code: string }
    aggregate Cancel { reason: string }
    repository Orders for Order { find f(): ${ret} }
  }
`;

describe("unions — anonymous `or` (P4)", () => {
  it("parses `A or B` as a head atom plus one alternative", () => {
    const t = findReturn(REPO("Order or Cancel"));
    expect(t.alternatives).toHaveLength(1);
    expect(isNamedType(t.base) && t.base.target.$refText).toBe("Order");
    expect(isNamedType(t.alternatives[0]!.base) && t.alternatives[0]!.base.target.$refText).toBe(
      "Cancel",
    );
  });

  it("parses a three-way `A or B or C`", () => {
    const t = findReturn(REPO("Order or Cancel or Order"));
    expect(t.alternatives).toHaveLength(2);
  });
});

describe("unions — `option` postfix carrier (P4)", () => {
  it("parses `T option` as a single postfix ctor", () => {
    const t = findReturn(REPO("Order option"));
    expect(t.ctors).toEqual(["option"]);
    expect(t.alternatives).toHaveLength(0);
  });

  it("postfix `option` binds tighter than `or` — `string or int option` is `string or (int option)`", () => {
    const t = findReturn(REPO("string or int option"));
    // Head atom is the bare `string`; the single alternative is `int option`.
    expect(isPrimitiveType(t.base) && t.base.name).toBe("string");
    expect(t.ctors).toHaveLength(0);
    expect(t.alternatives).toHaveLength(1);
    const alt = t.alternatives[0]!;
    expect(isTypeAtom(alt)).toBe(true);
    expect(isPrimitiveType(alt.base) && alt.base.name).toBe("int");
    expect(alt.ctors).toEqual(["option"]);
  });

  it("array binds tighter than `or` — `A or B[]` is `A or (B[])`", () => {
    const t = findReturn(REPO("Order or Cancel[]"));
    expect(t.array).toBe(false);
    expect(t.alternatives[0]!.array).toBe(true);
  });
});

describe("unions — named `payload Foo = A | B` (P4)", () => {
  it("parses a named union into PayloadDecl.variants (not fields)", () => {
    const model = parseRaw(`
      context C {
        payload OrderEvent = OrderPlaced | OrderCancelled | OrderShipped
      }
    `);
    const ctx = model.members.find((m) => m.$type === "BoundedContext") as {
      members: unknown[];
    };
    const decl = ctx.members.find((m) => isPayloadDecl(m as never)) as never;
    expect(isPayloadDecl(decl)).toBe(true);
    const p = decl as import("../../../src/language/generated/ast.js").PayloadDecl;
    expect(p.variants).toHaveLength(3);
    expect(p.fields).toHaveLength(0);
    expect(isNamedType(p.variants[0]!.base) && p.variants[0]!.base.target.$refText).toBe(
      "OrderPlaced",
    );
  });

  it("still parses the record form `payload X { … }`", () => {
    const model = parseRaw(`context C { payload X { a: int  b: string } }`);
    const ctx = model.members.find((m) => m.$type === "BoundedContext") as { members: unknown[] };
    const decl = ctx.members.find((m) => isPayloadDecl(m as never)) as never;
    const p = decl as import("../../../src/language/generated/ast.js").PayloadDecl;
    expect(p.fields).toHaveLength(2);
    expect(p.variants).toHaveLength(0);
  });
});

describe("unions — soft-keyword admission (P4)", () => {
  // `or` / `option` are soft keywords: admissible as field / parameter names.
  // The one inherent limitation — shared with P3's `paged` / `envelope` — is
  // that a field literally named such cannot immediately follow a typed field
  // (the name is otherwise slurped as a postfix ctor / `or` separator); the
  // leading-position cases below are the supported surface.
  it("keeps a leading field named `option` parsing", () => {
    expect(parseRawOk(`context C { event E { option: int } }`)).toBe(true);
  });

  it("keeps a leading field named `or` parsing", () => {
    expect(parseRawOk(`context C { event E { or: string } }`)).toBe(true);
  });

  it("keeps a parameter named `or` parsing", () => {
    expect(
      parseRawOk(`context C {
        aggregate A { x: int }
        repository R for A { find g(or: int): A }
      }`),
    ).toBe(true);
  });
});

describe("unions — variant validation (P4)", () => {
  it("rejects a duplicate variant in a named union (`loom.union-duplicate-variant`)", async () => {
    const { diagnostics } = await parseString(`
      context C {
        aggregate A { x: int }
        payload F = A | A
      }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.union-duplicate-variant");
  });

  it("rejects a duplicate variant in an anonymous `or` union", async () => {
    const { diagnostics } = await parseString(`
      context C {
        aggregate Order { code: string }
        repository R for Order { find f(): Order or Order }
      }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.union-duplicate-variant");
  });

  it("accepts a union of distinct variants (no duplicate diagnostic)", async () => {
    const { diagnostics } = await parseString(`
      context C {
        aggregate Order { code: string }
        aggregate Cancel { reason: string }
        repository R for Order { find f(): Order or Cancel }
      }
    `);
    expect(errorCodes(diagnostics)).not.toContain("loom.union-duplicate-variant");
  });

  it("rejects a `slot` union variant (`loom.union-variant-not-carrier`)", async () => {
    const { diagnostics } = await parseString(`
      context C {
        aggregate Order { code: string }
        repository R for Order { find f(): Order or slot }
      }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.union-variant-not-carrier");
  });

  it("rejects an inline union in a stored field position (`loom.union-position`)", async () => {
    const { diagnostics } = await parseString(`
      context C {
        aggregate Order { x: string or int }
      }
    `);
    expect(errorCodes(diagnostics)).toContain("loom.union-position");
  });

  it("allows an inline union as a repository find return", async () => {
    const { diagnostics } = await parseString(`
      context C {
        aggregate Order { code: string }
        aggregate Cancel { reason: string }
        repository R for Order { find f(): Order or Cancel }
      }
    `);
    expect(errorCodes(diagnostics)).not.toContain("loom.union-position");
  });
});
