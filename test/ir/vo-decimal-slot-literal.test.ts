// An integer-spelled literal in a DECIMAL value-object slot.
//
// `Money { amount: 0, currency: "USD" }` is ordinary Loom.  The literal is
// honestly an `int` at the token level, but the slot it fills is `decimal` — so
// an IR that keeps it as `int` is UNDER-RESOLVED, and every backend has to
// guess.  Three of them guess right by accident (TS `number`, C# implicit
// numeric conversion, Python duck-typing); Java's `BigDecimal` is a real type
// with no widening from `int`, so it emitted
//
//     new Money(0, "USD")   →   error: incompatible types: int cannot be
//                               converted to BigDecimal
//
// and failed `gradle testClasses`.  Lowering is the only place the declared
// slot type and the literal are both in hand, which is why the fix lives there
// and not in the Java renderer: one retype, five backends.
//
// WHY THIS WENT UNSEEN until now.  The one repo fixture that writes a decimal
// VO slot this way put it in a canonical `create` BODY — which no backend
// rendered (the drop this PR is about).  Correcting the fixture to a FIELD
// default is what first routed the expression to an emitter.  A latent bug and
// a silent drop hid each other: the drop meant the expression never compiled,
// and never compiling meant the bug never showed.

import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

const SRC = `
system P {
  subdomain D {
    context Sales {
      valueobject Money {
        amount: decimal
        currency: string
      }
      aggregate Order {
        code: string
        total: Money = Money { amount: 0, currency: "USD" }
        qty: int = 0
      }
      repository Orders for Order { }
    }
  }
  storage pg { type: postgres }
  resource st { for: Sales, kind: state, use: pg }
  deployable d { platform: node contexts: [Sales] dataSources: [st] port: 3000 }
}
`;

async function orderFields() {
  const { model, errors } = await parseString(SRC);
  expect(errors).toEqual([]);
  const loom = lowerModel(model);
  const agg = loom.systems
    .flatMap((s) => s.subdomains)
    .flatMap((d) => d.contexts)
    .flatMap((c) => c.aggregates)
    .find((a) => a.name === "Order");
  expect(agg, "Order lowered").toBeDefined();
  return agg!.fields;
}

describe("a value-object ctor's decimal slot retypes an integer literal", () => {
  it("lowers `amount: 0` in a decimal slot as a decimal literal", async () => {
    const total = (await orderFields()).find((f) => f.name === "total");
    const call = total?.default as Extract<ExprIR, { kind: "call" }> | undefined;
    expect(call?.kind, "the default lowered to a VO ctor call").toBe("call");
    expect(call?.callKind).toBe("value-object-ctor");

    const amount = call!.args[0] as Extract<ExprIR, { kind: "literal" }>;
    expect(amount.kind).toBe("literal");
    // The retype, and the whole point: `int` here is what Java cannot compile.
    expect(amount.lit).toBe("decimal");
    expect(amount.value).toBe("0");

    // The non-decimal slot is untouched — this is a slot-directed retype, not
    // a blanket "numbers become decimals".
    const currency = call!.args[1] as Extract<ExprIR, { kind: "literal" }>;
    expect(currency.lit).toBe("string");
  });

  it("leaves an integer literal in an INT slot alone", async () => {
    // The guard against over-firing: a `= 0` on a plain `int` field must stay
    // an int, or every backend's integer arithmetic silently becomes decimal.
    const qty = (await orderFields()).find((f) => f.name === "qty");
    const dflt = qty?.default as Extract<ExprIR, { kind: "literal" }>;
    expect(dflt.kind).toBe("literal");
    expect(dflt.lit).toBe("int");
  });
});
