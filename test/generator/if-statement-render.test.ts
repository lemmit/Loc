// M-FT.11 — the `if` statement on the four backends that share the
// `_stmt/target.ts` spine.
//
// One IR body, four leaf tables.  The spine owns the branch recursion; each
// leaf owns the conditional's SPELLING and — crucially — the nesting INDENT,
// because the spine renders a branch with the parent's own table (each table
// closes over its base indent rather than taking one).  Python is where that
// matters most: its indentation is structural, so a branch rendered at the
// parent's level is a syntax error, not a cosmetic wart.
//
// The elixir backend is deliberately absent: it refuses the statement up front
// (`loom.elixir-if-stmt-unsupported`, see ir/validate/checks/if-stmt-checks.ts)
// because a Phoenix body threads its result through a rebound `record` and an
// Elixir `if` block's bindings do not escape it.

import { describe, expect, it } from "vitest";
import { renderCsStatements } from "../../src/generator/dotnet/render-stmt.js";
import { renderJavaStatements } from "../../src/generator/java/render-stmt.js";
import { renderPyStatements } from "../../src/generator/python/render-stmt.js";
import { renderTsStatements } from "../../src/generator/typescript/render-stmt.js";
import type { ExprIR, PathIR, StmtIR } from "../../src/ir/types/loom-ir.js";

const int = (v: string): ExprIR => ({ kind: "literal", lit: "int", value: v });
const prop = (name: string): ExprIR => ({ kind: "ref", name, refKind: "this-prop" });
const path = (...segments: string[]): PathIR => ({ segments });
const assign = (field: string, v: string): StmtIR => ({
  kind: "assign",
  target: path(field),
  value: int(v),
  targetType: { kind: "primitive", name: "int" },
});
const gt0: ExprIR = {
  kind: "binary",
  op: ">",
  left: prop("count"),
  right: int("0"),
  leftType: { kind: "primitive", name: "int" },
  rightType: { kind: "primitive", name: "int" },
  resultType: { kind: "primitive", name: "bool" },
};

/** `if count > 0 { count := 1 } else { count := 2 }` */
const IF_ELSE: StmtIR[] = [
  { kind: "if", cond: gt0, thenBody: [assign("count", "1")], elseBody: [assign("count", "2")] },
];
/** The same without an `else`. */
const IF_ONLY: StmtIR[] = [{ kind: "if", cond: gt0, thenBody: [assign("count", "1")] }];
/** A nested `if` inside the then-branch — two indent levels. */
const NESTED: StmtIR[] = [
  {
    kind: "if",
    cond: gt0,
    thenBody: [{ kind: "if", cond: gt0, thenBody: [assign("count", "1")] }],
  },
];

describe("`if` statement — Hono / TypeScript", () => {
  it("renders braces and an else block", () => {
    expect(renderTsStatements(IF_ELSE)).toBe(
      [
        "    if (this._count > 0) {",
        "      this._count = 1;",
        "    } else {",
        "      this._count = 2;",
        "    }",
      ].join("\n"),
    );
  });

  it("omits the else block when the source had none", () => {
    expect(renderTsStatements(IF_ONLY)).toBe(
      ["    if (this._count > 0) {", "      this._count = 1;", "    }"].join("\n"),
    );
  });

  it("indents a nested `if` one level deeper per nesting level", () => {
    expect(renderTsStatements(NESTED)).toBe(
      [
        "    if (this._count > 0) {",
        "      if (this._count > 0) {",
        "        this._count = 1;",
        "      }",
        "    }",
      ].join("\n"),
    );
  });
});

describe("`if` statement — .NET", () => {
  it("renders braces and an else block", () => {
    expect(renderCsStatements(IF_ELSE)).toBe(
      [
        "        if (this.Count > 0) {",
        "            Count = 1;",
        "        } else {",
        "            Count = 2;",
        "        }",
      ].join("\n"),
    );
  });

  it("indents a nested `if` one level deeper", () => {
    const out = renderCsStatements(NESTED).split("\n");
    expect(out[1]).toBe("            if (this.Count > 0) {");
    expect(out[2]).toBe("                Count = 1;");
  });
});

describe("`if` statement — Java", () => {
  it("renders braces and an else block", () => {
    expect(renderJavaStatements(IF_ELSE)).toBe(
      [
        "        if (this.count > 0) {",
        "            this.count = 1;",
        "        } else {",
        "            this.count = 2;",
        "        }",
      ].join("\n"),
    );
  });
});

describe("`if` statement — Python", () => {
  // Python's indentation is SEMANTIC: a branch rendered at the parent's own
  // indent is an IndentationError, not a cosmetic wart.
  it("renders a colon-suite with a structurally indented body", () => {
    expect(renderPyStatements(IF_ELSE)).toBe(
      [
        "        if self._count > 0:",
        "            self._count = 1",
        "        else:",
        "            self._count = 2",
      ].join("\n"),
    );
  });

  it("nests two levels without flattening the inner suite", () => {
    expect(renderPyStatements(NESTED)).toBe(
      [
        "        if self._count > 0:",
        "            if self._count > 0:",
        "                self._count = 1",
      ].join("\n"),
    );
  });

  // The grammar admits `if c { }`, and an empty Python suite is a SyntaxError.
  it("emits `pass` for an empty branch", () => {
    const empty: StmtIR[] = [{ kind: "if", cond: gt0, thenBody: [], elseBody: [] }];
    expect(renderPyStatements(empty)).toBe(
      ["        if self._count > 0:", "            pass", "        else:", "            pass"].join(
        "\n",
      ),
    );
  });
});
