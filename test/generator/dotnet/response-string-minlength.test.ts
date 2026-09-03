// A RESPONSE schema must not claim a length bound nothing declared and nothing
// enforces.
//
// `RequiredAttribute` defaults `AllowEmptyStrings` to FALSE, and ASP.NET's
// schema generator translates that into `minLength: 1` on the published
// property. Response DTOs are serialized, never validated, so nothing enforces
// it — and for a plain `name: string` with no length invariant, nothing
// DECLARED it either. The result is the server breaking its own contract on a
// plain read (schemathesis F21 / W28, `response_schema_conformance`).
//
// ── Measured on a booted app, `aggregate Customer with crudish { name, email,
//    invariant email.length > 0 }` ─────────────────────────────────────────
//
//   POST {"name":"","email":"x"}          201   ← correct: `name` has no bound
//   GET  /api/customers          →  {"name":"", …}
//
//   published CustomerResponse, BEFORE:
//     name:  {"minLength": 1, "type": "string"}      ← a value the server sends
//     email: {"minLength": 1, "type": "string"}
//   AFTER:
//     name:  {"type": "string"}
//     email: {"type": "string"}
//
// `required` still lists every field in both — this is still a
// RequiredAttribute, so the required-set (and the strict-parity requiredDiffs
// gate) is untouched. Behaviour is untouched too, measured on the same app
// before and after:
//
//   {"name":"n","email":""}    422   invariant, enforced by FluentValidation
//   {"name":"","email":"x"}    201   nothing declared, nothing enforced
//   {"name":null,"email":"x"}  422   Required still sees null
//   {"email":"x"}              422   Required still sees the omission
//
// ── What this deliberately does NOT do ─────────────────────────────────────
// `email` DOES declare `length > 0`, and its `minLength: 1` was therefore
// accidentally correct. It goes too: after this change .NET publishes no
// length bound at all, which is what java already does (measured on a booted
// Spring app — its `CustomerResponse` and `CreateCustomerRequest` carry no
// minLength either, in a model where node's request schema does).
//
// Publishing the bounds a `len-*` invariant actually declares is a separate
// slice, and has to go through the schema-document layer on both backends:
// the DataAnnotations that would publish them — `[MinLength]` / `[MaxLength]`
// — also ENFORCE them, counting UTF-16 code units rather than the code points
// the bound is defined in (src/generator/_expr/code-point.ts). Trading a false
// claim for a wrong count is not an improvement.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/parse.js";

const SRC = `
  context Shop {
    valueobject Money { amount: decimal  currency: string }
    aggregate Customer with crudish {
      name: string
      email: string
      note: string?
      price: Money
      invariant email.length > 0
    }
    repository Customers for Customer { }
  }
`;

async function emitted(suffix: string): Promise<string> {
  const { model, errors } = await parseString(SRC);
  expect(errors).toEqual([]);
  const files = generateDotnet(model);
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key as string) as string;
}

describe("dotnet — a response string publishes no length bound it cannot keep", () => {
  it("required response strings allow the empty string", async () => {
    const responses = await emitted("Customers/Responses/CustomerResponses.cs");
    expect(responses).toContain("[property: Required(AllowEmptyStrings = true)] string Name");
    expect(responses).toContain("[property: Required(AllowEmptyStrings = true)] string Email");
    // The bare form is what publishes the phantom `minLength: 1`.
    expect(responses).not.toContain("[property: Required] string ");
  });

  it("non-string response members are untouched", async () => {
    // `AllowEmptyStrings` is a string-only concern; putting it on a Guid or an
    // int would be noise at best and is not what the fix is about.
    const responses = await emitted("Customers/Responses/CustomerResponses.cs");
    expect(responses).toContain("[property: Required] Guid Id");
    expect(responses).toContain("[property: Required] int Version");
  });

  it("the field stays REQUIRED — this is still a RequiredAttribute", async () => {
    // The required-set is what the strict-parity requiredDiffs gate compares
    // across backends. Downgrading to a plain property, or dropping the
    // attribute, would silently move it.
    const responses = await emitted("Customers/Responses/CustomerResponses.cs");
    for (const member of ["string Name", "string Email"]) {
      const at = responses.indexOf(member);
      expect(at, `${member} not emitted`).toBeGreaterThan(-1);
      // Deliberately matched on `Required`, not `Required(` — this is a guard
      // against LOSING the attribute (which would move the required-set), not
      // a second copy of the assertion above. It must stay green whichever
      // form the fix settles on.
      expect(responses.slice(0, at)).toContain("[property: Required");
    }
  });

  it("the REQUEST side is unchanged", async () => {
    // Requests already carried AllowEmptyStrings, for a different and still
    // valid reason: `[Required]` would reject `""` structurally and pre-empt
    // the domain invariant that answers 422 on every other backend.
    const requests = await emitted("Customers/Requests/CustomerRequests.cs");
    expect(requests).toContain("[Required(AllowEmptyStrings = true)] string Name");
    expect(requests).toContain("[Required(AllowEmptyStrings = true)] string Email");
    // Parameter target, not property target — a property-targeted Required on
    // a positional record makes ASP.NET throw at model-binding time.
    expect(requests).not.toContain("[property: Required(AllowEmptyStrings = true)] string Name");
  });

  it("an OPTIONAL string is not made required by this", async () => {
    // `note: string?` is nullable on the wire; it carries no Required at all,
    // and the change must not reach it.
    const responses = await emitted("Customers/Responses/CustomerResponses.cs");
    expect(responses).toContain("string? Note");
    expect(responses).not.toContain("Required(AllowEmptyStrings = true)] string? Note");
  });

  it("a value object's response strings get the same treatment", async () => {
    // The nested case: a VO is its own schema, published under its own name,
    // and would carry the same phantom bound.
    const responses = await emitted("Customers/Responses/CustomerResponses.cs");
    const money = responses.slice(responses.indexOf("record MoneyResponse("));
    expect(money).toContain("[property: Required(AllowEmptyStrings = true)] string Currency");
  });
});
