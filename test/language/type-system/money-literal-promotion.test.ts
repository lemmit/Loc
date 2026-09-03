// Literal-promotion to money — the ergonomic source form for money
// values when the surrounding context determines the type.  A bare
// `373.34` flowing into a money declaration, money parameter, or
// alongside a money operand in a binary expression is treated as
// money — both at validation (no "decimal is not assignable to
// money" error) and at lowering (the IR carries
// `lit("money", "373.34")` so backends emit
// `new Decimal("373.34")`, not `373.34`).
//
// The promotion is one-sided: a numeric VALUE (a `taxRate: decimal`
// field used in `subtotal + taxRate`) still rejects.  The strict
// `decimal ↔ money` boundary from #506 is preserved for typed
// values; only bare literals — which carry no user-chosen type —
// are contextually polymorphic.

import { AstUtils, EmptyFileSystem, URI } from "langium";
import { describe, expect, it } from "vitest";
import { allAggregates } from "../../../src/ir/types/loom-ir.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";
import { buildLoomModel } from "../../_helpers/index.js";
import { parseString } from "../../_helpers/parse.js";

async function _linkedModel(src: string): Promise<Model> {
  const services = createDddServices(EmptyFileSystem).Ddd;
  const shared = services.shared;
  const uri = URI.parse("memory:///money-literal-promotion.ddd");
  const docs = shared.workspace.LangiumDocuments;
  if (docs.hasDocument(uri)) await docs.deleteDocument(uri);
  const doc = shared.workspace.LangiumDocumentFactory.fromString(src, uri);
  docs.addDocument(doc);
  await shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

function _findAgg(model: Model, name: string): Aggregate {
  for (const n of AstUtils.streamAst(model)) {
    if (n.$type === "Aggregate" && (n as { name?: string }).name === name) {
      return n as Aggregate;
    }
  }
  throw new Error(`no aggregate ${name}`);
}

describe("money literal promotion — validator accepts the ergonomic form", () => {
  it("`derived total: money = 373.34` validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          derived total: money = 373.34
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`derived total: money = 100` (int literal) validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          derived total: money = 100
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`subtotal + 0.50` (money + decimal literal) validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          derived withFee: money = subtotal + 0.50
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`0.50 + subtotal` (commutative) validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          derived withFee: money = 0.50 + subtotal
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`subtotal > 0` (money > int literal) validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          derived positive: bool = subtotal > 0
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("`subtotal >= 0.00` in an invariant validates", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          invariant subtotal >= 0.00
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("assignment `subtotal := 0` validates (precondition skipped — only the := matters)", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          operation reset() {
            subtotal := 0
          }
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("money literal promotion — typed values still reject", () => {
  // The point of the strict gate (#506) is to keep value-level coercion
  // explicit.  A `decimal`-typed field opposite a money operand stays
  // an error — only bare literals get the ergonomic pass.

  it("`subtotal + taxRate` (money + decimal field) still errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          taxRate: decimal
          derived bad: money = subtotal + taxRate
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/incompatible operand types/);
  });

  it("`subtotal == taxRate` (money == decimal field) still errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          subtotal: money
          taxRate: decimal
          derived bad: bool = subtotal == taxRate
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/cannot compare/);
  });

  it("`derived total: money = taxRate` (assignment from decimal field) still errors", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          taxRate: decimal
          derived total: money = taxRate
        }
        repository Foos for Foo { }
      }
    `);
    expect(errors.join("\n")).toMatch(/Derived 'total' has expression of type 'decimal'/);
  });
});

describe("money literal promotion — IR carries the elaborated money literal", () => {
  // The lowering layer mirrors the validator: a numeric literal in a
  // money-typed context lowers to `lit("money", value)`, NOT
  // `lit("decimal", value)`.  Backends consume the IR shape directly
  // — without this, the TS emit would be `subtotal.plus(0.50)`
  // (passing a JS number to decimal.js) instead of
  // `subtotal.plus(new Decimal("0.50"))`.

  it("derived prop's RHS literal lowers as money", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          derived total: money = 373.34
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const total = foo.derived.find((d) => d.name === "total")!;
    expect(total.expr).toEqual({
      kind: "literal",
      lit: "money",
      value: "373.34",
    });
  });

  it("int literal in money context lowers as money (value stringified)", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          derived total: money = 100
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const total = foo.derived.find((d) => d.name === "total")!;
    expect(total.expr).toEqual({
      kind: "literal",
      lit: "money",
      value: "100",
    });
  });

  it("money + literal binary IR carries leftType=money, rightType=money", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          subtotal: money
          derived withFee: money = subtotal + 0.50
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const withFee = foo.derived.find((d) => d.name === "withFee")!;
    const bin = withFee.expr as Extract<typeof withFee.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
    // The right operand was the literal — it lowers to a money lit.
    expect(bin.right).toEqual({
      kind: "literal",
      lit: "money",
      value: "0.50",
    });
  });
});

// ---------------------------------------------------------------------------
// Scaling (`*`, `/`) is money × SCALAR — the promotion must NOT apply there.
//
// The promotion above is what makes `subtotal + 0.50` ergonomic, and it was
// applied at EVERY operator.  `moneyArithmetic` (type-system.ts) rejects
// `money × money` and `money ÷ money` outright — money is closed under `±` and
// the comparisons, not under scaling — so promoting the scalar literal to money
// manufactured the exact combination the type-system refuses.  The result was a
// diagnostic that contradicted itself:
//
//   derived half: money = price / 2
//   -> Operator '/' has incompatible operand types: left is 'money', right is
//      'money'.  Allowed for money: ... money / {int|long|decimal}.
//
// `price / decimal(2)` (an explicit conversion, not a literal) always worked,
// but the message named no path to it.  `money` therefore anchors `+` / `-` and
// the comparisons and nothing else; `long` / `decimal` anchor every operator as
// before.  Both mirrors move together — `_shared.ts`'s `literalPromotionAnchor`
// and `lower-expr.ts`'s — because the validator and the lowerer disagreeing
// about the same expression is what turns a false rejection into a trap.
// ---------------------------------------------------------------------------
describe("money scaling by a literal — the scalar operand keeps its own type", () => {
  const scaling = (body: string) => `
      context X {
        aggregate Foo {
          price: money
          qty: int
          ${body}
        }
        repository Foos for Foo { }
      }
    `;

  it("`price * 2` (money x int literal) validates", async () => {
    const { errors } = await parseString(scaling("derived scaled: money = price * 2"));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("`price / 2` (money / int literal) validates", async () => {
    const { errors } = await parseString(scaling("derived half: money = price / 2"));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("`price * 2.5` (money x decimal literal) validates", async () => {
    const { errors } = await parseString(scaling("derived frac: money = price * 2.5"));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("`2 * price` (commutative) validates", async () => {
    const { errors } = await parseString(scaling("derived rev: money = 2 * price"));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("`price + 1` still promotes — money IS closed under `+`", async () => {
    const { errors } = await parseString(scaling("derived sum: money = price + 1"));
    expect(errors, errors.join("\n")).toEqual([]);
  });

  it("money x money between two TYPED values is still rejected", async () => {
    const { errors } = await parseString(`
      context X {
        aggregate Foo {
          price: money
          fee: money
          derived bad: money = price * fee
        }
        repository Foos for Foo { }
      }
    `);
    expect(
      errors.some((e) => /Operator '\*' has incompatible operand types/.test(e)),
      errors.join("\n"),
    ).toBe(true);
  });

  it("the IR keeps the scalar literal scalar — money x int, not money x money", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          price: money
          derived half: money = price / 2
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const half = foo.derived.find((d) => d.name === "half")!;
    const bin = half.expr as Extract<typeof half.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.rightType).toEqual({ kind: "primitive", name: "int" });
    // `toMatchObject`, not `toEqual`: an UNpromoted literal keeps the span of
    // the AST node it came from, while a promoted one is synthesized and has
    // none.  The load-bearing part is `lit: "int"` — the promoted form would
    // read `lit: "money"`, which is what made this expression uncompilable.
    expect(bin.right).toMatchObject({ kind: "literal", lit: "int", value: "2" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
  });

  it("a `decimal` anchor still promotes under `*` — only money is scaling-only", async () => {
    const loom = await buildLoomModel(`
      context X {
        aggregate Foo {
          rate: decimal
          derived doubled: decimal = rate * 2
        }
        repository Foos for Foo { }
      }
    `);
    const foo = allAggregates(loom).find((a) => a.name === "Foo")!;
    const doubled = foo.derived.find((d) => d.name === "doubled")!;
    const bin = doubled.expr as Extract<typeof doubled.expr, { kind: "binary" }>;
    expect(bin.right).toEqual({ kind: "literal", lit: "decimal", value: "2" });
  });
});
