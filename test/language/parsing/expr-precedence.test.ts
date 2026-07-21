// Operator-precedence and postfix-chain shape coverage for the
// flattened grammar (Wave 1A).
//
// Each test embeds the expression as the RHS of a `derived label = <EXPR>`
// in a minimal aggregate and asserts:
//   (a) the AST shape (BinaryChain / TernaryExpr / PostfixChain / UnaryExpr),
//   (b) the lowered IR (via `lowerExpr` through `buildLoomModel`).
//
// Precedence climbing stays grammar-structural (per the design), but each
// precedence rule now emits a flat `BinaryChain { head, ops[], rest[] }`
// instead of a recursive `BinaryExpr`.  Postfix `.` / `(…)` collapse into
// a single `PostfixChain { head, suffixes[] }` whose suffixes are a
// `MemberSuffix | CallSuffix` discriminator.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { allAggregates, type ExprIR } from "../../../src/ir/types/loom-ir.js";
import type {
  BinaryChain,
  DerivedProp,
  Expression,
  PostfixChain,
  TernaryExpr,
  UnaryExpr,
} from "../../../src/language/generated/ast.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { parseValid } from "../../_helpers/parse.js";

const wrap = (rhs: string, extra = ""): string => `
context X {
  aggregate Foo {
    a: int
    b: int
    c: int
    d: int
    e: int
    f: int
    ${extra}
    derived label: decimal = ${rhs}
  }
  repository Foos for Foo { }
}
`;

/** Locate the `derived label` AST node in a parsed model and return its
 *  RHS Expression — the unit under test. */
async function rhsOf(source: string): Promise<Expression> {
  const m = await parseValid(source);
  for (const node of AstUtils.streamAst(m)) {
    if (node.$type === "DerivedProp" && (node as DerivedProp).name === "label") {
      return (node as DerivedProp).expr;
    }
  }
  throw new Error("derived 'label' not found");
}

/** Look up the lowered IR of the same `derived label` expression. */
async function loweredOf(source: string): Promise<ExprIR> {
  const loom = await buildLoomModel(source);
  const foo = allAggregates(loom).find((a) => a.name === "Foo");
  if (!foo) throw new Error("aggregate Foo not found");
  const d = foo.derived.find((x) => x.name === "label");
  if (!d) throw new Error("derived 'label' not found");
  return d.expr;
}

describe("expr-precedence: flat BinaryChain shape", () => {
  it("`a + b + c` produces a 3-operand BinaryChain (head + 2 rest)", async () => {
    const expr = await rhsOf(wrap("a + b + c"));
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual(["+", "+"]);
    expect(bc.rest.length).toBe(2);
    // Lowered IR: pure left-fold → (+, (+, a, b), c).
    const ir = await loweredOf(wrap("a + b + c"));
    expect(ir.kind).toBe("binary");
    const top = ir as Extract<ExprIR, { kind: "binary" }>;
    expect(top.op).toBe("+");
    expect((top.right as { kind: string }).kind).toBe("ref");
    const lhs = top.left as Extract<ExprIR, { kind: "binary" }>;
    expect(lhs.kind).toBe("binary");
    expect(lhs.op).toBe("+");
  });

  it("`a - b - c` lowers left-associatively → (-, (-, a, b), c)", async () => {
    const ir = await loweredOf(wrap("a - b - c"));
    const top = ir as Extract<ExprIR, { kind: "binary" }>;
    expect(top.op).toBe("-");
    const lhs = top.left as Extract<ExprIR, { kind: "binary" }>;
    expect(lhs.op).toBe("-");
  });

  it("`a * b / c` keeps a flat BinaryChain at the multiplicative level", async () => {
    const expr = await rhsOf(wrap("a * b / c"));
    expect(expr.$type).toBe("BinaryChain");
    expect((expr as BinaryChain).ops).toEqual(["*", "/"]);
    const ir = await loweredOf(wrap("a * b / c"));
    // Left-fold: (/, (*, a, b), c)
    const top = ir as Extract<ExprIR, { kind: "binary" }>;
    expect(top.op).toBe("/");
    expect((top.left as Extract<ExprIR, { kind: "binary" }>).op).toBe("*");
  });

  it("`a && b && c` keeps a flat BinaryChain at the AND level", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: bool c: bool
    derived label: bool = a && b && c
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual(["&&", "&&"]);
  });

  it("`1 + 2 * 3` splits across two precedence levels (additive owns mul)", async () => {
    const expr = await rhsOf(wrap("1 + 2 * 3"));
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual(["+"]);
    // The single rest entry is itself a BinaryChain at the multiplicative level.
    expect(bc.rest[0]!.$type).toBe("BinaryChain");
  });

  it("`a || b && c` keeps `&&` deeper than `||`", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: bool c: bool
    derived label: bool = a || b && c
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual(["||"]);
    expect(bc.rest[0]!.$type).toBe("BinaryChain");
  });

  it("`a && b || c && d` splits at `||` with two AND-chains underneath", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: bool c: bool d: bool
    derived label: bool = a && b || c && d
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual(["||"]);
    expect((bc.head as BinaryChain).$type).toBe("BinaryChain");
    expect((bc.rest[0] as BinaryChain).$type).toBe("BinaryChain");
  });

  it("`a == b && c == d` keeps each `==` at the equality level under a top AND", async () => {
    const src = `
context X {
  aggregate Foo {
    a: int b: int c: int d: int
    derived label: bool = a == b && c == d
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual(["&&"]);
    expect((bc.head as BinaryChain).$type).toBe("BinaryChain");
    expect((bc.rest[0] as BinaryChain).$type).toBe("BinaryChain");
  });

  it("`-a + b` keeps unary tighter than additive", async () => {
    const expr = await rhsOf(wrap("-a + b"));
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect((bc.head as UnaryExpr).$type).toBe("UnaryExpr");
  });

  it("`!a && b` keeps unary tighter than logical AND", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: bool
    derived label: bool = !a && b
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect((bc.head as UnaryExpr).$type).toBe("UnaryExpr");
  });
});

describe("expr-precedence: TernaryExpr (right-assoc)", () => {
  it("`a ? b : c ? d : e` nests on the else branch (right-assoc)", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: int c: bool d: int e: int
    derived label: int = a ? b : c ? d : e
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("TernaryExpr");
    const t = expr as TernaryExpr;
    expect(t.elseExpr.$type).toBe("TernaryExpr");
  });

  it("`a || b ? c : d` makes the condition a BinaryChain", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: bool c: int d: int
    derived label: int = a || b ? c : d
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("TernaryExpr");
    expect((expr as TernaryExpr).cond.$type).toBe("BinaryChain");
  });

  it("`a ? b + c : d` makes the then-branch a BinaryChain", async () => {
    const src = `
context X {
  aggregate Foo {
    a: bool b: int c: int d: int
    derived label: int = a ? b + c : d
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("TernaryExpr");
    expect((expr as TernaryExpr).thenExpr.$type).toBe("BinaryChain");
  });
});

describe("expr-precedence: PostfixChain shape", () => {
  it("`a.b.c` parses as ONE PostfixChain with 2 MemberSuffix entries", async () => {
    const src = `
context X {
  aggregate Order {
    contains lines: OrderLine[]
    derived label: int = lines.first.qty
    entity OrderLine {
      qty: int
    }
  }
  repository Orders for Order { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("PostfixChain");
    const pc = expr as PostfixChain;
    expect(pc.head.$type).toBe("NameRef");
    expect(pc.suffixes.length).toBe(2);
    expect(pc.suffixes[0]!.$type).toBe("MemberSuffix");
    expect(pc.suffixes[1]!.$type).toBe("MemberSuffix");
  });

  it("`a.b().c` produces one MemberSuffix(call=true) and one MemberSuffix(no call)", async () => {
    // Uses a real string intrinsic + `.length` — a CALL on a primitive
    // receiver must resolve in the intrinsic catalogue since the strict
    // unknown-intrinsic gate (loom.intrinsic-unknown) landed.
    const src = `
context X {
  aggregate Foo {
    a: string
    derived label: int = a.trim().length
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("PostfixChain");
    const pc = expr as PostfixChain;
    expect(pc.suffixes.length).toBe(2);
    const s0 = pc.suffixes[0]!;
    const s1 = pc.suffixes[1]!;
    if (s0.$type !== "MemberSuffix" || s1.$type !== "MemberSuffix") {
      throw new Error("suffixes should both be MemberSuffix");
    }
    expect(s0.call).toBe(true);
    expect(s1.call).toBe(false);
  });

  it("`a.b(1).c` keeps suffix order = source order", async () => {
    const src = `
context X {
  aggregate Foo {
    a: string
    derived label: int = a.substring(1).length
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("PostfixChain");
    const pc = expr as PostfixChain;
    expect(pc.suffixes.length).toBe(2);
    const s0 = pc.suffixes[0];
    expect(s0?.$type).toBe("MemberSuffix");
  });
});

describe("expr-precedence: mixed binary + postfix", () => {
  it("`subtotal + tax > limit` puts the additive chain in the head, the limit in rest", async () => {
    const src = `
context X {
  aggregate Foo {
    subtotal: int tax: int limit: int
    derived label: bool = subtotal + tax > limit
  }
  repository Foos for Foo { }
}`;
    const expr = await rhsOf(src);
    expect(expr.$type).toBe("BinaryChain");
    const bc = expr as BinaryChain;
    expect(bc.ops).toEqual([">"]);
    expect((bc.head as BinaryChain).$type).toBe("BinaryChain");
  });
});

describe("expr-precedence: money promotion per fold-step", () => {
  it("`price + 0.50 + tax` promotes 0.50 to a money literal at the right fold-step", async () => {
    const src = `
context X {
  aggregate Foo {
    price: money
    tax: money
    derived label: money = price + 0.50 + tax
  }
  repository Foos for Foo { }
}`;
    const ir = await loweredOf(src);
    // The chain lowers to `(+, (+, price, 0.50@money), tax)` — both binary
    // nodes carry result type money, and the literal at the first
    // fold-step was promoted from decimal → money.
    const top = ir as Extract<ExprIR, { kind: "binary" }>;
    expect(top.kind).toBe("binary");
    expect(top.resultType).toEqual({ kind: "primitive", name: "money" });
    const lhs = top.left as Extract<ExprIR, { kind: "binary" }>;
    expect(lhs.kind).toBe("binary");
    expect(lhs.resultType).toEqual({ kind: "primitive", name: "money" });
    // `toMatchObject` — a promoted literal built directly by
    // `tryPromoteNumericLit` bypasses the `lowerExpr` origin wrapper today
    // (src/ir/lower/lower-expr.ts), but pin the assertion loosely so a future
    // change to stamp it doesn't break this test on an unrelated field.
    expect(lhs.right).toMatchObject({ kind: "literal", lit: "money", value: "0.50" });
  });
});
