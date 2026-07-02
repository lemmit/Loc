// Gate for the centralized-escaping slice (A1): a `.ddd`-sourced string,
// regex pattern, or reserved-word identifier is spliced into generated target
// source, so each backend must materialize it through the target-language
// escaping funnel — otherwise a value like `"hi#{System.cmd(...)}"` executes at
// Elixir compile time, a `/` closes an Elixir `~r/…/` sigil, `matches("")`
// renders the JS line-comment `//`, a `<` breaks the HEEx tokenizer, and a
// reserved-word column breaks the Postgres DDL.
//
// Pure string rendering over hand-built IR — no IO.  Follows the
// `let-keyword-escape.test.ts` convention (unit tests over the renderers).

import { describe, expect, it } from "vitest";
import { renderCsExpr } from "../../src/generator/dotnet/render-expr.js";
import { escapeHeexAttr, escapeHeexText } from "../../src/generator/elixir/heex-walker-core.js";
import { renderExpr as renderElixirExpr } from "../../src/generator/elixir/render-expr.js";
import { renderJavaExpr } from "../../src/generator/java/render-expr.js";
import { renderPyExpr } from "../../src/generator/python/render-expr.js";
import { renderPgStep } from "../../src/generator/sql-pg.js";
import { renderTsExpr } from "../../src/generator/typescript/render-expr.js";
import type { ExprIR, TypeIR } from "../../src/ir/types/loom-ir.js";
import type { MigrationStep } from "../../src/ir/types/migrations-ir.js";
import { elixirRegexBody, elixirString } from "../../src/util/naming.js";

const STRING: TypeIR = { kind: "primitive", name: "string" };

function strLit(value: string): ExprIR {
  return { kind: "literal", lit: "string", value };
}

/** `<field>.matches("<pattern>")` — the string-regex intrinsic. */
function matches(pattern: string): ExprIR {
  return {
    kind: "method-call",
    receiver: { kind: "ref", name: "email", refKind: "param", type: STRING },
    member: "matches",
    args: [strLit(pattern)],
    receiverType: STRING,
    isCollectionOp: false,
  };
}

// ---------------------------------------------------------------------------
// Elixir string literals — must not open `#{…}` interpolation.
// ---------------------------------------------------------------------------

describe("Elixir string literal escaping", () => {
  it("neutralizes `#{` interpolation in a `.ddd` string", () => {
    const out = renderElixirExpr(strLit("hi#{oops}"));
    // The `#{` is escaped so Elixir reads it as literal text, not interpolation.
    expect(out).toBe('"hi\\#{oops}"');
    expect(out).not.toMatch(/[^\\]#\{/); // no unescaped #{
  });

  it("code-injection payload does not interpolate", () => {
    const out = renderElixirExpr(strLit('#{System.cmd("rm", ["-rf", "/"])}'));
    expect(out).toContain("\\#{");
    expect(out).not.toMatch(/^"#\{/);
  });

  it("escapes an embedded double-quote", () => {
    expect(renderElixirExpr(strLit('a"b'))).toBe('"a\\"b"');
  });

  it("leaves an ordinary string byte-identical", () => {
    expect(renderElixirExpr(strLit("hello world"))).toBe('"hello world"');
  });

  it("elixirString helper is the shared funnel", () => {
    expect(elixirString("x#{y}")).toBe('"x\\#{y}"');
    expect(elixirString("plain")).toBe('"plain"');
  });
});

// ---------------------------------------------------------------------------
// Elixir regex `~r/…/` sigil — `/` must not close it, `#{` must not fire.
// ---------------------------------------------------------------------------

describe("Elixir regex sigil escaping", () => {
  it("escapes `/` and `#{` inside the sigil", () => {
    const out = renderElixirExpr(matches("a/b#{c}"));
    expect(out).toContain("~r/a\\/b\\#{c}/");
    // The raw (unescaped) form must NOT appear.
    expect(out).not.toContain("~r/a/b");
  });

  it("elixirRegexBody helper escapes both hazards", () => {
    expect(elixirRegexBody("^/x/#{q}$")).toBe("^\\/x\\/\\#{q}$");
    // A regex metacharacter backslash (`\d`) is untouched.
    expect(elixirRegexBody("\\d+")).toBe("\\d+");
  });
});

// ---------------------------------------------------------------------------
// TypeScript regex literal — empty + trailing-backslash edges.
// ---------------------------------------------------------------------------

describe("TypeScript regex literal edges", () => {
  it("does not render `//` (a line comment) for an empty pattern", () => {
    const out = renderTsExpr(matches(""));
    expect(out).not.toContain("//");
    expect(out).toContain('new RegExp("")');
  });

  it("falls back to RegExp ctor for a dangling trailing backslash", () => {
    const out = renderTsExpr(matches("abc\\"));
    // A `/abc\/` literal would escape the closing slash and break parsing.
    expect(out).toContain("new RegExp(");
    expect(out).not.toMatch(/\/abc\\\/\.test/);
  });

  it("escapes an embedded slash in an ordinary pattern", () => {
    const out = renderTsExpr(matches("a/b"));
    expect(out).toContain("/a\\/b/.test");
  });
});

// ---------------------------------------------------------------------------
// C# / Java / Python string literals — confirm genuinely non-interpolating.
// ---------------------------------------------------------------------------

describe("non-interpolating backends pass `{`/`#{` through literally", () => {
  const payload = "a{b}#{c}";
  it("C# plain string literal is inert", () => {
    const out = renderCsExpr(strLit(payload));
    expect(out).toBe(JSON.stringify(payload)); // "a{b}#{c}" — no `$"` interpolation
  });
  it("Java string literal is inert", () => {
    expect(renderJavaExpr(strLit(payload))).toBe(JSON.stringify(payload));
  });
  it("Python string literal is inert (no f-string)", () => {
    expect(renderPyExpr(strLit(payload))).toBe(JSON.stringify(payload));
  });
});

// ---------------------------------------------------------------------------
// HEEx text + attribute escaping funnel.
// ---------------------------------------------------------------------------

describe("HEEx escaping funnel", () => {
  it("entity-escapes tag/interpolation openers in text position", () => {
    expect(escapeHeexText("<b> & </b>")).toBe("&lt;b&gt; &amp; &lt;/b&gt;");
    // A `<%= evil %>` in text becomes inert.
    expect(escapeHeexText("<%= evil %>")).toBe("&lt;%= evil %&gt;");
  });

  it("quote-escapes an attribute value", () => {
    expect(escapeHeexAttr('a"b & c')).toBe("a&quot;b &amp; c");
  });

  it("leaves ordinary text/attrs byte-identical", () => {
    expect(escapeHeexText("Order total")).toBe("Order total");
    expect(escapeHeexAttr("data-table")).toBe("data-table");
  });
});

// ---------------------------------------------------------------------------
// Postgres DDL — reserved-word identifiers must be quoted.
// ---------------------------------------------------------------------------

describe("Postgres DDL identifier quoting", () => {
  it("double-quotes a reserved-word column and table", () => {
    const step: MigrationStep = {
      op: "createTable",
      table: {
        name: "order",
        ownerModule: "sales",
        columns: [
          { name: "id", type: { kind: "uuid" }, nullable: false },
          { name: "user", type: { kind: "text" }, nullable: false },
          { name: "order", type: { kind: "int" }, nullable: false },
        ],
        primaryKey: ["id"],
        foreignKeys: [],
        indexes: [],
      },
    };
    const sql = renderPgStep(step);
    expect(sql).toContain('CREATE TABLE "order"');
    expect(sql).toContain('"user" TEXT NOT NULL');
    expect(sql).toContain('"order" INTEGER NOT NULL');
    expect(sql).toContain('PRIMARY KEY ("id")');
    // No bare reserved word as an identifier.
    expect(sql).not.toMatch(/\(\s*user /);
  });
});
