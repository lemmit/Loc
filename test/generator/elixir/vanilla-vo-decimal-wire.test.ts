import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// vanilla Phoenix — RS-24 for a plain `decimal` INSIDE A VALUE OBJECT, after an
// OPERATION has written it.
//
// RS-24 already says a plain `decimal` is a JSON number and names its trigger as
// "a GET returning an aggregate — or a NESTED VALUE OBJECT — with a `decimal`
// field", and `__decimal_num/1` is the helper that enforces it.  The gap was in
// what reaches that helper.
//
// A value object persists as a plain `:map` (jsonb), and its two writers
// disagree about the encoding:
//
//   - CREATE runs the changeset cast, so the client's JSON number (`100`) is
//     what lands in the column;
//   - an OPERATION computes (`Decimal.add(...)`) and `force_change`s the map, so
//     a `%Decimal{}` reaches Jason — which encodes a Decimal as a STRING, and
//     the column then holds `"125"`.
//
// Coming back out, the jsonb value is already a bare string, so
// `__decimal_num/1`'s `%Decimal{}` clause never matched and the wire shipped
// `"125"` where the other four backends ship `125`.  An RS-24 break visible only
// AFTER an operation had written the value — which is why create-only coverage
// never saw it.  Found 2026-08-05 by the caller-census drain
// (`corpus/domain-services`' `deposit`/`withdraw`).
// ---------------------------------------------------------------------------

const SOURCE = `
system Bank {
  subdomain Core {
    context Accounts {
      valueobject Money {
        amount: decimal
        currency: string
      }
      valueobject Fee {
        charge: money
      }
      aggregate Account with crudish {
        holder: string
        balance: Money
        fee: Fee
        operation deposit(amount: Money) {
          balance := Money { amount: balance.amount + amount.amount, currency: balance.currency }
        }
      }
      repository Accounts for Account { }
    }
  }
  api AccountsApi from Core
  storage pg { type: postgres }
  resource s { for: Accounts, kind: state, use: pg }
  deployable d { platform: elixir, contexts: [Accounts], dataSources: [s], port: 4000 }
}
`;

const controller = async (): Promise<string> => {
  const files = await generateSystemFiles(SOURCE);
  const hit = [...files.entries()].find(([p]) => p.endsWith("account_controller.ex"));
  expect(hit, "no account_controller.ex").toBeDefined();
  return hit![1];
};

describe("vanilla Phoenix — a VO's plain decimal is a JSON number from either writer", () => {
  it("__decimal_num parses the STRING form the operation writer leaves in jsonb", async () => {
    const ctrl = await controller();

    // Premise: the VO decimal really does route through the RS-24 helper.
    expect(ctrl).toContain("__decimal_num(");

    // The `%Decimal{}` clause (the original RS-24 fix) is still there…
    expect(ctrl).toContain("defp __decimal_num(%Decimal{} = dec), do: Decimal.to_float(dec)");
    // …and so is the BINARY clause — the second writer's form.
    expect(ctrl).toContain("defp __decimal_num(bin) when is_binary(bin) do");
    expect(ctrl).toContain('{dec, ""} -> Decimal.to_float(dec)');
    // Nil-safe, and anything else passes through.
    expect(ctrl).toContain("defp __decimal_num(nil), do: nil");
    expect(ctrl).toContain("defp __decimal_num(other), do: other");
  });

  it("MONEY is untouched — it keeps its fixed-scale string (RS-12)", async () => {
    // Scope guard.  The two types must not collapse: a fix that parsed every
    // decimal-ish string would turn `money` into a number and break RS-12.
    // `money` rides `__money_round/1`, a different helper, and this asserts the
    // separation survives.
    const ctrl = await controller();
    expect(ctrl).toContain("__money_round(");
    // The money VO field is serialized through the money helper, never the
    // plain-decimal one.
    const feeSerializer = ctrl.slice(ctrl.indexOf("defp serialize_fee(record)"));
    const body = feeSerializer.slice(0, feeSerializer.indexOf("\n  end"));
    expect(body).toContain("__money_round(");
    expect(body).not.toContain("__decimal_num(");
  });
});
