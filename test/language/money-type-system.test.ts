// Phase 0 of the `money` primitive — closed arithmetic semantics and
// (non-)assignability with the existing numeric primitives.  See
// `/root/.claude/plans/i-think-we-have-glittery-lecun.md`.
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
import { createDddServices } from "../../src/language/ddd-module.js";
import type {
  Aggregate,
  DerivedProp,
  Expression,
  Model,
} from "../../src/language/generated/ast.js";
import { envForNode, isAssignable, T, typeOf } from "../../src/language/type-system.js";

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
