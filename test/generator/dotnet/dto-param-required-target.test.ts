// Required-ness attribute TARGET on .NET DTO record parameters.
//
// On a positional record, `[property: Required]` puts the metadata on the
// generated property — which ASP.NET's record validation rejects at
// model-binding time: `ThrowIfRecordTypeHasValidationOnProperties` throws
// `InvalidOperationException`, surfacing as a 500 on the first POST that
// carries a required field (before the controller/handler runs).  Request
// DTOs must therefore target the constructor PARAMETER (bare `[Required]`);
// response DTOs are only serialized (never model-bound) and keep
// `[property: Required]` so Swashbuckle's property reader marks them
// required in the response schema.

import { describe, expect, it } from "vitest";
import { dtoParam } from "../../../src/generator/dotnet/dto-mapping.js";

describe("dtoParam — required-ness attribute target", () => {
  it("requests target the ctor parameter (bare [Required]), not the property", () => {
    // Required STRINGS carry `AllowEmptyStrings = true` so an empty string
    // passes the structural layer and is rejected by the domain invariant
    // as 422 (matching Hono/Phoenix) instead of a 400 model-validation error.
    expect(dtoParam("string", "Name", "request")).toBe(
      "[Required(AllowEmptyStrings = true)] string Name",
    );
    // Non-string required fields keep the bare `[Required]` (AllowEmptyStrings
    // is string-only; null/omitted still 400s).
    expect(dtoParam("Visibility", "Visibility", "request")).toBe(
      "[Required] Visibility Visibility",
    );
    expect(dtoParam("decimal", "Amount", "request")).toBe("[Required] decimal Amount");
    // Never emit the property-targeted form on a request — that's the 500.
    expect(dtoParam("string", "Name", "request")).not.toContain("[property:");
  });

  it("responses keep [property: Required] (serialized, never model-bound)", () => {
    expect(dtoParam("string", "Name", "response")).toBe("[property: Required] string Name");
    expect(dtoParam("Guid", "Id", "response")).toBe("[property: Required] Guid Id");
  });

  it("nullable types are not marked required in either direction", () => {
    expect(dtoParam("string?", "Description", "request")).toBe("string? Description");
    expect(dtoParam("Guid?", "ExternalId", "response")).toBe("Guid? ExternalId");
  });

  it("a non-nullable bool in a REQUEST is not required (omitted → false)", () => {
    expect(dtoParam("bool", "Active", "request")).toBe("bool Active");
    // … but in a response it is marked required.
    expect(dtoParam("bool", "Active", "response")).toBe("[property: Required] bool Active");
  });
});
