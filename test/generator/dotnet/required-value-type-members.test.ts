// A REQUIRED member the schema advertises must be enforced whatever its CLR
// kind — and for a VALUE TYPE, `[Required]` alone cannot do it.
//
// `RequiredAttribute` tests for null. A missing `int` / `decimal` / `Guid` /
// enum binds to the CLR default (0 / Guid.Empty / the first enum member), which
// is not null, so validation passes and the write proceeds with a value the
// caller never sent. A missing `string` or record binds to null and IS caught.
// So enforcement of the published `required` set depended on nothing more than
// whether the field happened to be a reference type.
//
// ── Measured on a booted .NET app, before the fix ──────────────────────────
// `POST /api/widgets`, every one of these listed in the schema's `required`:
//
//     omit name  (string)          422   ← reference type, caught
//     omit price (record)          422   ← reference type, caught
//     omit qty   (int)             201   ← VALUE TYPE, stored as 0
//     omit ratio (decimal)         201   ← VALUE TYPE, stored as 0
//     omit price.amount (decimal)  201   ← VALUE TYPE, stored as 0
//     omit active (bool)           201   ← correct: RS-6 keeps `bool` OPTIONAL
//                                          on a create body, and the schema
//                                          agrees — it is NOT in `required`,
//                                          so nothing is claimed unenforced.
//
// A zero-priced product / zero-quantity widget written from a body the contract
// forbids (schemathesis F30). After the fix all five required omissions answer
// 422 with real pointers, `active` still answers 201, and a genuinely malformed
// body still answers 400.
//
// ── Why `[property: JsonRequired]`, and why the status arm moved with it ────
// JsonRequired asks the question actually being asked — "was the member
// PRESENT" — and the file already used it for operation bodies (RS-26). The
// reason it could not simply be switched on everywhere is that its failure
// landed in the `Malformed JSON in request body` **400** arm, which is wrong on
// its face (the JSON parsed; a member was absent) and would have moved the
// already-correct reference-type cases from 422 to 400. So the guard and the
// status arm move together: `FromModelState` now routes a missing-required-
// member error to the 422 tier, and only that.
//
// It is matched on the message because System.Text.Json raises no distinct
// exception type — and, measured, hangs NO exception on the model-state entry
// at all; the text is the whole signal:
//
//     $ => Exception: none
//          ErrorMessage: JSON deserialization for type '…CreateWidgetRequest'
//                        was missing required properties including: 'qty'.
//
// If a future runtime rewords that, the match stops firing and the answer falls
// back to the 400 it gave before — today's behaviour, never a crash and never a
// laxer contract.
//
// ── The published schema does not move ─────────────────────────────────────
// Diffed live before/after on two booted apps: byte-identical. This changes
// what is ENFORCED, never what is ADVERTISED — which is what makes it a fix
// rather than a contract change.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    valueobject Money { amount: decimal  currency: string }
    aggregate Widget with crudish {
      name: string
      qty: int
      ratio: decimal
      active: bool
      price: Money
    }
    repository Widgets for Widget { }
  }
`;

async function requests(): Promise<string> {
  const { model, errors } = await parseString(SRC);
  expect(errors).toEqual([]);
  const files = generateDotnet(model);
  const key = [...files.keys()].find((k) => k.endsWith("Widgets/Requests/WidgetRequests.cs"));
  expect(key, "WidgetRequests.cs not emitted").toBeDefined();
  return files.get(key as string) as string;
}

/** One record's positional parameter list. */
function record(src: string, name: string): string {
  const start = src.indexOf(`public sealed record ${name}(`);
  expect(start, `record ${name} not emitted`).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf("\n", start));
}

describe("dotnet — a required VALUE-TYPE member is actually enforced", () => {
  it("value-type members of a create body carry JsonRequired", async () => {
    const create = record(await requests(), "CreateWidgetRequest");
    expect(create).toContain("[property: JsonRequired] [Required] int Qty");
    expect(create).toContain("[property: JsonRequired] [Required] decimal Ratio");
  });

  it("value-type members of a VALUE OBJECT carry it too", async () => {
    // The nested case, and the one the fuzzer actually found: `price.amount`
    // omitted while `price` itself is present.
    const money = record(await requests(), "MoneyRequest");
    expect(money).toContain("[property: JsonRequired] [Required] decimal Amount");
  });

  it("REFERENCE-typed members deliberately do NOT get it", async () => {
    // Their `[Required]` already answers 422. Adding JsonRequired would move
    // them into the deserialization failure path — a status regression on the
    // half that was always correct.
    const src = await requests();
    const create = record(src, "CreateWidgetRequest");
    const money = record(src, "MoneyRequest");
    expect(create).toContain("[Required(AllowEmptyStrings = true)] string Name");
    expect(create).not.toContain(
      "[property: JsonRequired] [Required(AllowEmptyStrings = true)] string Name",
    );
    expect(create).toContain("[Required] MoneyRequest Price");
    expect(create).not.toContain("[property: JsonRequired] [Required] MoneyRequest Price");
    expect(money).toContain("[Required(AllowEmptyStrings = true)] string Currency");
    expect(money).not.toContain(
      "[property: JsonRequired] [Required(AllowEmptyStrings = true)] string Currency",
    );
  });

  it("an OPTIONAL bool stays optional — RS-6 is not collateral damage", async () => {
    // `bool` on a create body is deliberately optional, and the schema agrees by
    // omitting it from `required`. A guard here would enforce something the
    // contract does not claim, which is the mirror-image bug.
    const create = record(await requests(), "CreateWidgetRequest");
    expect(create).toContain("bool Active");
    expect(create).not.toContain("[property: JsonRequired] [Required] bool Active");
  });

  it("the 422 arm claims the missing-member failure, and only it", async () => {
    const { model, errors } = await parseString(SRC);
    expect(errors).toEqual([]);
    const files = generateDotnet(model);
    const vp = [...files].find(([p]) => p.endsWith("Api/ValidationProblem.cs"))?.[1] as string;
    expect(vp, "ValidationProblem.cs not emitted").toBeDefined();

    // Reads ErrorMessage, because the measured model-state entry carries no
    // exception at all — checking `error.Exception` alone never fires.
    expect(vp).toContain('const string MissingRequiredMarker = "missing required properties";');
    expect(vp).toContain(
      "error.ErrorMessage.Contains(MissingRequiredMarker, StringComparison.Ordinal)",
    );
    expect(vp).toContain("StatusCode = 422,");

    // …and a genuinely unreadable body must still reach the 400 arm.
    expect(vp).toContain('Detail = "Malformed JSON in request body",');
  });
});
