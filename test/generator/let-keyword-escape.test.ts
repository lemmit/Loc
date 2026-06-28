// Regression: a `let`-binding named after a target-language reserved word
// must be escaped at the binding AND every `refKind: "let"` use, on every
// backend that runs domain logic — otherwise the emitted source fails to
// compile (`let base = …` → C# `var base = …` is a syntax error).  See
// `src/util/naming.ts` (escape<Lang>Ident) and each backend's render-stmt /
// render-expr.  A non-keyword name must be emitted byte-identically.
//
// Pure string rendering, no IO.

import { describe, expect, it } from "vitest";
import { renderCsStatements } from "../../src/generator/dotnet/render-stmt.js";
import { renderJavaStatements } from "../../src/generator/java/render-stmt.js";
import { renderPyStatements } from "../../src/generator/python/render-stmt.js";
import { renderTsStatements } from "../../src/generator/typescript/render-stmt.js";
import type { StmtIR, TypeIR } from "../../src/ir/types/loom-ir.js";

const INT: TypeIR = { kind: "primitive", name: "int" };

/** `let <name> = 1; let other = <ref to name> + 2` — exercises binding + use. */
function bindThenUse(name: string): StmtIR[] {
  return [
    { kind: "let", name, type: INT, expr: { kind: "literal", lit: "int", value: "1" } },
    {
      kind: "let",
      name: "other",
      type: INT,
      expr: {
        kind: "binary",
        op: "+",
        left: { kind: "ref", name, refKind: "let" },
        right: { kind: "literal", lit: "int", value: "2" },
      },
    },
  ];
}

describe("let-binding keyword escaping — .NET", () => {
  it("escapes a C#-keyword name at binding and use", () => {
    const out = renderCsStatements(bindThenUse("base"));
    expect(out).toContain("var @base = 1;");
    expect(out).toContain("@base + 2");
    expect(out).not.toMatch(/var base =/);
  });

  it("leaves a non-keyword name byte-identical", () => {
    const out = renderCsStatements(bindThenUse("subtotal"));
    expect(out).toContain("var subtotal = 1;");
    expect(out).toContain("subtotal + 2");
    expect(out).not.toContain("@");
  });
});

describe("let-binding keyword escaping — TypeScript", () => {
  it("escapes a JS-reserved-word name at binding and use", () => {
    const out = renderTsStatements(bindThenUse("class"));
    expect(out).toContain("const class_ = 1;");
    expect(out).toContain("class_ + 2");
  });

  it("leaves a non-keyword name byte-identical", () => {
    const out = renderTsStatements(bindThenUse("subtotal"));
    expect(out).toContain("const subtotal = 1;");
    expect(out).toContain("subtotal + 2");
  });
});

describe("let-binding keyword escaping — Java", () => {
  it("escapes a Java-keyword name at binding and use", () => {
    const out = renderJavaStatements(bindThenUse("final"));
    expect(out).toContain("var final_ = 1;");
    expect(out).toContain("final_ + 2");
  });

  it("leaves a non-keyword name byte-identical", () => {
    const out = renderJavaStatements(bindThenUse("subtotal"));
    expect(out).toContain("var subtotal = 1;");
    expect(out).toContain("subtotal + 2");
  });
});

describe("let-binding keyword escaping — Python", () => {
  it("escapes a Python-keyword name at binding and use", () => {
    const out = renderPyStatements(bindThenUse("class"));
    expect(out).toContain("class_ = 1");
    expect(out).toContain("class_ + 2");
  });

  it("leaves a non-keyword name byte-identical", () => {
    const out = renderPyStatements(bindThenUse("subtotal"));
    expect(out).toContain("subtotal = 1");
    expect(out).toContain("subtotal + 2");
  });
});
