// Per-kind isolation tests for `printExpr` — pins the exact string
// output for each Expression shape that the printer dispatches on.
// The corpus-driven round-trip tests
// (`print-roundtrip.test.ts`, `print-structural-roundtrip.test.ts`)
// cover every kind indirectly via parse-equality; this file locks
// the formatting (operator spacing, separators, paren preservation,
// match-arm comma separation) that a round-trip would miss when
// two distinct strings parse to the same AST.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import type {
  Aggregate,
  BoundedContext,
  DerivedProp,
  Expression,
  Invariant,
  Property,
} from "../../../src/language/generated/ast.js";
import { isAggregate } from "../../../src/language/generated/ast.js";
import { printExpr } from "../../../src/language/print/index.js";
import { parseString } from "../../_helpers/index.js";

/** Parse a one-aggregate snippet and return the named derived property's expression. */
async function derivedExpr(aggBody: string, derivedName: string): Promise<Expression> {
  const { model, errors } = await parseString(`
    context T {
      aggregate A {
        ${aggBody}
      }
    }
  `);
  if (errors.length) throw new Error(`parse errors: ${errors.join("; ")}`);
  for (const m of model.members ?? []) {
    if (m.$type !== "BoundedContext") continue;
    const ctx = m as BoundedContext;
    for (const cm of ctx.members ?? []) {
      if (!isAggregate(cm)) continue;
      const agg = cm as Aggregate;
      for (const am of agg.members ?? []) {
        if (am.$type === "DerivedProp" && (am as DerivedProp).name === derivedName) {
          return (am as DerivedProp).expr;
        }
      }
    }
  }
  throw new Error(`derived ${derivedName} not found`);
}

/** Parse and return the named property's `check` expression. */
async function checkExpr(aggBody: string, propName: string): Promise<Expression> {
  const { model, errors } = await parseString(`
    context T {
      aggregate A {
        ${aggBody}
      }
    }
  `);
  if (errors.length) throw new Error(`parse errors: ${errors.join("; ")}`);
  for (const node of AstUtils.streamAllContents(model)) {
    if (node.$type === "Property" && (node as Property).name === propName) {
      const p = node as Property;
      if (!p.check) throw new Error(`property ${propName} has no check`);
      return p.check;
    }
  }
  throw new Error(`property ${propName} not found`);
}

/** Parse and return the first invariant expression in the aggregate. */
async function firstInvariant(aggBody: string): Promise<Expression> {
  const { model, errors } = await parseString(`
    context T {
      aggregate A {
        ${aggBody}
      }
    }
  `);
  if (errors.length) throw new Error(`parse errors: ${errors.join("; ")}`);
  for (const m of model.members ?? []) {
    if (m.$type !== "BoundedContext") continue;
    const ctx = m as BoundedContext;
    for (const cm of ctx.members ?? []) {
      if (!isAggregate(cm)) continue;
      const agg = cm as Aggregate;
      for (const am of agg.members ?? []) {
        if (am.$type === "Invariant") return (am as Invariant).expr;
      }
    }
  }
  throw new Error("invariant not found");
}

describe("printExpr — literals", () => {
  it("StringLit re-quotes the JSON-escaped form", async () => {
    const e = await derivedExpr(`name: string  derived label: string = "Mr " + name`, "label");
    // The full chain: "Mr " + name → BinaryChain; head is StringLit
    expect(printExpr(e)).toBe('"Mr " + name');
  });

  it("IntLit / DecLit / NullLit / NowExpr emit minimal text", async () => {
    const i = await derivedExpr(`x: int  derived n: int = 42`, "n");
    expect(printExpr(i)).toBe("42");
    const d = await derivedExpr(`x: decimal  derived n: decimal = 3.14`, "n");
    expect(printExpr(d)).toBe("3.14");
    const nu = await derivedExpr(`x: string?  derived n: string? = null`, "n");
    expect(printExpr(nu)).toBe("null");
    const nw = await derivedExpr(`x: datetime  derived n: datetime = now()`, "n");
    expect(printExpr(nw)).toBe("now()");
  });

  it("MoneyLit prints as `money(\"…\")`", async () => {
    const m = await derivedExpr(
      `x: money  derived n: money = money("9.99")`,
      "n",
    );
    expect(printExpr(m)).toBe('money("9.99")');
  });

  it("BoolLit prints as `true` / `false`", async () => {
    const t = await derivedExpr(`x: bool  derived n: bool = true`, "n");
    expect(printExpr(t)).toBe("true");
    const f = await derivedExpr(`x: bool  derived n: bool = false`, "n");
    expect(printExpr(f)).toBe("false");
  });
});

describe("printExpr — binary precedence + spacing", () => {
  it("BinaryChain emits operands separated by `<space><op><space>`", async () => {
    const e = await derivedExpr(`x: int  derived n: int = x + 1`, "n");
    expect(printExpr(e)).toBe("x + 1");
  });

  it("chained binary keeps left-fold flat without parens", async () => {
    const e = await derivedExpr(`x: int  derived n: int = x + 1 + 2`, "n");
    expect(printExpr(e)).toBe("x + 1 + 2");
  });

  it("ParenExpr around a binary survives the round-trip as `(…)`", async () => {
    const e = await derivedExpr(`x: int  derived n: int = (x + 1) * 2`, "n");
    expect(printExpr(e)).toBe("(x + 1) * 2");
  });

  it("UnaryExpr renders with the operator immediately adjacent to the operand", async () => {
    const e = await derivedExpr(`active: bool  derived inactive: bool = !active`, "inactive");
    expect(printExpr(e)).toBe("!active");
  });

  it("TernaryExpr renders with `cond ? then : else` spacing", async () => {
    const e = await derivedExpr(
      `x: int  derived label: string = x > 0 ? "pos" : "neg"`,
      "label",
    );
    expect(printExpr(e)).toBe('x > 0 ? "pos" : "neg"');
  });
});

describe("printExpr — postfix chain (member + call)", () => {
  it("renders dotted member access without spaces around `.`", async () => {
    const e = await derivedExpr(
      `email: string  derived ok: bool = email.length > 0`,
      "ok",
    );
    expect(printExpr(e)).toBe("email.length > 0");
  });

  it("renders a method-call suffix as `recv.member(args)`", async () => {
    const e = await checkExpr(`email: string check email.matches("^[a-z]+$")`, "email");
    expect(printExpr(e)).toBe('email.matches("^[a-z]+$")');
  });

  it("renders multiple args comma-separated", async () => {
    const e = await firstInvariant(
      `items: int[]
       invariant items.all(x => x > 0)`,
    );
    const printed = printExpr(e);
    expect(printed).toBe("items.all(x => x > 0)");
  });

  it("admits the `where` collection op as a method name (soft keyword in MemberName)", async () => {
    const e = await derivedExpr(
      `items: int[]  derived positive: int[] = items.where(x => x > 0)`,
      "positive",
    );
    expect(printExpr(e)).toBe("items.where(x => x > 0)");
  });
});

describe("printExpr — match", () => {
  it("renders single-arm match with arms comma-separated and `else =>` on its own arm", async () => {
    const e = await derivedExpr(
      `x: int
       derived label: string = match {
         x > 0 => "pos"
         else  => "neg"
       }`,
      "label",
    );
    const printed = printExpr(e);
    expect(printed).toBe('match {\nx > 0 => "pos",\nelse => "neg"\n}');
  });

  it("multi-arm match comma-separates every arm (round-trip precondition)", async () => {
    const e = await derivedExpr(
      `x: int
       derived label: string = match {
         x > 1 => "big"
         x > 0 => "small"
         else  => "zero"
       }`,
      "label",
    );
    const printed = printExpr(e);
    // Two real arms + an else fallthrough → two commas total.
    expect(printed.split(/^/m).filter((l) => l.endsWith(",\n")).length).toBe(2);
  });
});

describe("printExpr — primitive conversion", () => {
  it("renders `string(x)` round-trip", async () => {
    const e = await derivedExpr(
      `n: int  derived label: string = string(n)`,
      "label",
    );
    expect(printExpr(e)).toBe("string(n)");
  });

  it("renders `money(x)` round-trip", async () => {
    const e = await derivedExpr(
      `n: int  derived amt: money = money(n)`,
      "amt",
    );
    expect(printExpr(e)).toBe("money(n)");
  });
});

describe("printExpr — receivers (`this`, `id`)", () => {
  it("ThisRef prints as the bare `this`", async () => {
    const e = await firstInvariant(`x: int  invariant this.x > 0`);
    expect(printExpr(e)).toBe("this.x > 0");
  });

  it("IdRef prints as the bare `id`", async () => {
    const e = await derivedExpr(
      `name: string  derived label: string = name + string(id)`,
      "label",
    );
    expect(printExpr(e)).toBe("name + string(id)");
  });
});
