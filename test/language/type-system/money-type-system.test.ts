// `money` primitive — closed arithmetic semantics and
// (non-)assignability with the existing numeric primitives.
//
// money exists as a primitive distinct from decimal:
//   money ± money              → money
//   money × {int|long|decimal} → money     (commutative; scalar × money OK)
//   money ÷ {int|long|decimal} → money
//   anything else involving money → unknown (rejected at the type layer)
//
// Negative cases below declare the derived as `bool` so the validator's
// `checkDerived` suppresses its own type-mismatch error (it skips when
// `actual.kind === "unknown"`), letting us inspect `typeOf` directly.

import { AstUtils, EmptyFileSystem, URI } from "langium";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type {
  Aggregate,
  DerivedProp,
  Expression,
  Model,
} from "../../../src/language/generated/ast.js";
import { envForNode, isAssignable, T, typeOf } from "../../../src/language/type-system.js";

async function linkedModel(src: string): Promise<Model> {
  const services = createDddServices(EmptyFileSystem).Ddd;
  const shared = services.shared;
  const uri = URI.parse("memory:///money-type-system.ddd");
  const docs = shared.workspace.LangiumDocuments;
  if (docs.hasDocument(uri)) await docs.deleteDocument(uri);
  const doc = shared.workspace.LangiumDocumentFactory.fromString(src, uri);
  docs.addDocument(doc);
  await shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

function findAgg(model: Model, name: string): Aggregate {
  for (const n of AstUtils.streamAst(model)) {
    if (n.$type === "Aggregate" && (n as { name?: string }).name === name) {
      return n as Aggregate;
    }
  }
  throw new Error(`no aggregate ${name}`);
}

function derivedExpr(agg: Aggregate, name: string): Expression {
  const d = agg.members.find(
    (m): m is DerivedProp => m.$type === "DerivedProp" && (m as { name: string }).name === name,
  );
  if (!d) throw new Error(`no derived ${name} on ${agg.name}`);
  return d.expr;
}

const SRC = `
context Billing {
  aggregate Invoice {
    subtotal: money
    qty:      int
    rate:     decimal

    // Closed: money ± money = money
    derived plus:  money = subtotal + subtotal
    derived minus: money = subtotal - subtotal

    // Scaling: money × {decimal|int|long} = money (commutative)
    derived scaledByDecimal: money = subtotal * rate
    derived scaledByInt:     money = subtotal * qty
    derived scaledLeft:      money = rate * subtotal

    // Money ÷ scalar = money
    derived divByScalar: money = subtotal / rate

    // --- Rejected (typed as bool so the validator stays quiet; we
    //     inspect typeOf directly to confirm 'unknown' is returned).

    // money + scalar — not allowed.
    derived addMixed: bool = subtotal + rate

    // money × money — rejected (we only allow scaling, not multiplication of
    // two prices).
    derived mulMoney: bool = subtotal * subtotal

    // money ÷ money — rejected (no implicit ratio-as-decimal).
    derived divMoney: bool = subtotal / subtotal

    // scalar ÷ money — rejected (only money ÷ scalar makes domain sense).
    derived scalarDivMoney: bool = rate / subtotal
  }

  repository Invoices for Invoice { }
}
`;

describe("money — soft keyword (backward-compat with pre-#498 .ddd)", () => {
  // `money` is a hard keyword only in `PrimitiveType` (`amount:
  // money`) and `MoneyLit` (`money("…")`).  Everywhere else —
  // field / parameter / property names, expression NameRefs — it
  // must remain admissible as an identifier so pre-existing files
  // that named a field `money` (like web/src/examples/pokemon-
  // world.ddd) keep parsing cleanly.  Without this, adding the
  // `money` primitive in #498 silently broke any file using
  // `money` as an identifier.

  it("`money` may name a field of any type", async () => {
    const { parseValid } = await import("../../_helpers/parse.js");
    await parseValid(`
      context Game {
        aggregate Trainer {
          money: int
          badges: int
          invariant money >= 0
          invariant badges <= money
        }
        repository Trainers for Trainer { }
      }
    `);
  });

  it("`money` may name an operation parameter", async () => {
    const { parseValid } = await import("../../_helpers/parse.js");
    await parseValid(`
      context Game {
        aggregate Trainer {
          balance: int
          operation deposit(money: int) {
            balance := balance + money
          }
        }
        repository Trainers for Trainer { }
      }
    `);
  });

  it("`money` in expression position resolves through the env (not as a money literal)", async () => {
    const m = await linkedModel(`
      context Game {
        aggregate Trainer {
          money: int
          derived doubled: int = money + money
        }
        repository Trainers for Trainer { }
      }
    `);
    const trainer = findAgg(m, "Trainer");
    const doubled = derivedExpr(trainer, "doubled");
    const t = typeOf(doubled, envForNode(doubled));
    expect(t.kind).toBe("primitive");
    // The field's declared type wins — `money` references resolve
    // to the `int` field, not to the `money` primitive constructor.
    expect((t as { name: string }).name).toBe("int");
  });
});

describe('money — literal form `money("...")`', () => {
  // `money(...)` is a primary expression form for a precise-decimal
  // literal — analogous to `now()` for datetime.  The string argument
  // is what every backend's host-language Decimal type parses from
  // without precision loss.

  it('`money("10.50")` parses as a primary expression', async () => {
    const m = await linkedModel(`
      context Billing {
        aggregate Invoice {
          derived starting: money = money("10.50")
        }
        repository Invoices for Invoice { }
      }
    `);
    const inv = findAgg(m, "Invoice");
    const starting = derivedExpr(inv, "starting");
    const t = typeOf(starting, envForNode(starting));
    expect(t.kind).toBe("primitive");
    expect((t as { name: string }).name).toBe("money");
  });

  it('`money("…")` lowers to a `literal` IR node with kind=money', async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          derived starting: money = money("10.50")
        }
        repository Invoices for Invoice { }
      }
    `);
    const { allAggregates } = await import("../../../src/ir/types/loom-ir.js");
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const starting = inv.derived.find((d) => d.name === "starting")!;
    // `toMatchObject` — this literal lowers through the `lowerExpr` wrapper
    // (src/ir/lower/lower-expr.ts), which stamps a real M14 `origin`.
    expect(starting.expr).toMatchObject({
      kind: "literal",
      lit: "money",
      value: "10.50",
    });
  });

  it('`money("…")` participates in money arithmetic', async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          subtotal: money
          derived withFee: money = subtotal + money("1.00")
        }
        repository Invoices for Invoice { }
      }
    `);
    const { allAggregates } = await import("../../../src/ir/types/loom-ir.js");
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const withFee = inv.derived.find((d) => d.name === "withFee")!;
    const bin = withFee.expr as Extract<typeof withFee.expr, { kind: "binary" }>;
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
  });
});

describe("money — primitive type parses and lowers", () => {
  let model: Model;
  beforeAll(async () => {
    model = await linkedModel(SRC);
  });

  it("parses `money` as a field type", () => {
    const inv = findAgg(model, "Invoice");
    const subtotal = inv.members.find(
      (m): m is { $type: string; name: string } =>
        m.$type === "Property" && (m as { name: string }).name === "subtotal",
    );
    expect(subtotal).toBeDefined();
  });

  it("typeOf on a money-typed name reference is `primitive money`", () => {
    const inv = findAgg(model, "Invoice");
    const plus = derivedExpr(inv, "plus");
    const env = envForNode(plus);
    // `plus` is `subtotal + subtotal`; both sides should type as money,
    // and the binary result must too.
    const t = typeOf(plus, env);
    expect(t.kind).toBe("primitive");
    expect((t as { name: string }).name).toBe("money");
  });
});

describe("money — closed arithmetic", () => {
  let model: Model;
  let inv: Aggregate;
  beforeAll(async () => {
    model = await linkedModel(SRC);
    inv = findAgg(model, "Invoice");
  });

  const expectMoney = (derivedName: string) => {
    const expr = derivedExpr(inv, derivedName);
    const t = typeOf(expr, envForNode(expr));
    expect({ derived: derivedName, kind: t.kind, name: (t as { name?: string }).name }).toEqual({
      derived: derivedName,
      kind: "primitive",
      name: "money",
    });
  };

  const expectUnknown = (derivedName: string) => {
    const expr = derivedExpr(inv, derivedName);
    const t = typeOf(expr, envForNode(expr));
    expect({ derived: derivedName, kind: t.kind }).toEqual({
      derived: derivedName,
      kind: "unknown",
    });
  };

  it("money + money → money", () => expectMoney("plus"));
  it("money - money → money", () => expectMoney("minus"));
  it("money × decimal → money", () => expectMoney("scaledByDecimal"));
  it("money × int → money", () => expectMoney("scaledByInt"));
  it("decimal × money → money (commutative)", () => expectMoney("scaledLeft"));
  it("money ÷ decimal → money", () => expectMoney("divByScalar"));

  it("money + decimal → rejected (unknown)", () => expectUnknown("addMixed"));
  it("money × money → rejected (unknown)", () => expectUnknown("mulMoney"));
  it("money ÷ money → rejected (unknown)", () => expectUnknown("divMoney"));
  it("decimal ÷ money → rejected (unknown)", () => expectUnknown("scalarDivMoney"));
});

describe("money — IR binary node carries leftType & resultType", () => {
  // The binary IR node gains `leftType`/`resultType` populated during
  // lowering.  Backends use them to dispatch operator rendering
  // (e.g. Phoenix `Decimal.add/2`, TS `a.plus(b)`) without re-running
  // type inference.

  it("`money + money` IR carries leftType=money and resultType=money", async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          subtotal: money
          derived plus: money = subtotal + subtotal
        }
        repository Invoices for Invoice { }
      }
    `);
    const { allAggregates } = await import("../../../src/ir/types/loom-ir.js");
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const plus = inv.derived.find((d) => d.name === "plus")!;
    expect(plus.expr.kind).toBe("binary");
    const bin = plus.expr as Extract<typeof plus.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
  });

  it("`money * decimal` IR carries resultType=money (scaling)", async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          subtotal: money
          taxRate: decimal
          derived tax: money = subtotal * taxRate
        }
        repository Invoices for Invoice { }
      }
    `);
    const { allAggregates } = await import("../../../src/ir/types/loom-ir.js");
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const tax = inv.derived.find((d) => d.name === "tax")!;
    const bin = tax.expr as Extract<typeof tax.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "money" });
  });

  it("`money == money` IR carries resultType=bool (comparison)", async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          subtotal: money
          paid: money
          derived isSettled: bool = subtotal == paid
        }
        repository Invoices for Invoice { }
      }
    `);
    const { allAggregates } = await import("../../../src/ir/types/loom-ir.js");
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const settled = inv.derived.find((d) => d.name === "isSettled")!;
    const bin = settled.expr as Extract<typeof settled.expr, { kind: "binary" }>;
    expect(bin.leftType).toEqual({ kind: "primitive", name: "money" });
    expect(bin.resultType).toEqual({ kind: "primitive", name: "bool" });
  });
});

describe("money — array.sum is money-aware", () => {
  // The IR-layer `memberType` for `array.sum` now returns money when
  // the array's element type is money, so collection-op aggregation
  // doesn't silently demote precision through the wire shape.

  it("money[].sum → money (not decimal)", async () => {
    const { buildLoomModel } = await import("../../_helpers/index.js");
    const loom = await buildLoomModel(`
      context Billing {
        aggregate Invoice {
          contains lines: LineItem[]
          derived total: money = lines.sum(l => l.amount)
          entity LineItem {
            amount: money
          }
        }
        repository Invoices for Invoice { }
      }
    `);
    const { allAggregates } = await import("../../../src/ir/types/loom-ir.js");
    const inv = allAggregates(loom).find((a) => a.name === "Invoice")!;
    const _total = inv.derived.find((d) => d.name === "total")!;
    // The IR-side wireShape for the derived 'total' field carries the
    // computed type — money preserved through the collection-op.
    const totalField = inv.wireShape!.find((f) => f.name === "total");
    expect(totalField).toBeDefined();
    expect(totalField!.type).toEqual({ kind: "primitive", name: "money" });
  });
});

describe("money — array.avg types money-aware", () => {
  // `avg(λ)` returns the MEAN, optional (empty → null).  A money projection
  // averages to `money?`; every other numeric projection (int/long/decimal) to
  // `decimal?`.  `avg` desugars during lowering, so its type is decided here at
  // the AST/type-system layer (collectionOpType).

  const AVG_SRC = `
    context Billing {
      aggregate Invoice {
        contains lines: LineItem[]
        derived avgPrice: money?   = lines.avg(l => l.amount)
        derived avgQty:   decimal? = lines.avg(l => l.qty)
        entity LineItem { amount: money  qty: int }
      }
      repository Invoices for Invoice { }
    }
  `;

  it("money[].avg → money? (not decimal?)", async () => {
    const model = await linkedModel(AVG_SRC);
    const inv = findAgg(model, "Invoice");
    const expr = derivedExpr(inv, "avgPrice");
    expect(typeOf(expr, envForNode(expr))).toEqual(T.opt(T.prim("money")));
  });

  it("int[].avg → decimal? (numeric projection widens to decimal)", async () => {
    const model = await linkedModel(AVG_SRC);
    const inv = findAgg(model, "Invoice");
    const expr = derivedExpr(inv, "avgQty");
    expect(typeOf(expr, envForNode(expr))).toEqual(T.opt(T.prim("decimal")));
  });
});

describe("money — isAssignable", () => {
  // No DSL source needed — exercise the function directly with crafted
  // DddType values.  Same-type assignment OK; cross-type with decimal
  // forbidden in both directions; the existing numeric-widening chain
  // (int → long → decimal) is unaffected.

  const money = T.prim("money");
  const decimal = T.prim("decimal");
  const intT = T.prim("int");
  const longT = T.prim("long");

  it("money → money is assignable", () => {
    expect(isAssignable(money, money)).toBe(true);
  });

  it("decimal → money is NOT assignable (no implicit narrowing into money)", () => {
    expect(isAssignable(decimal, money)).toBe(false);
  });

  it("money → decimal is NOT assignable (no implicit widening out of money)", () => {
    expect(isAssignable(money, decimal)).toBe(false);
  });

  it("int → money is NOT assignable", () => {
    expect(isAssignable(intT, money)).toBe(false);
  });

  it("money → int is NOT assignable", () => {
    expect(isAssignable(money, intT)).toBe(false);
  });

  it("existing int → long widening is unaffected", () => {
    expect(isAssignable(intT, longT)).toBe(true);
  });

  it("existing int → decimal widening is unaffected", () => {
    expect(isAssignable(intT, decimal)).toBe(true);
  });
});
