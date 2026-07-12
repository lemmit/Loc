// Regression: the .NET DTO emitter must render a Request/Response record
// for a value object reached only THROUGH another value object's field.
//
// `emitResponseDtos` / `emitRequestDtos` render a `<Vo>Response` /
// `<Vo>Request` record per value object on the aggregate's surface; each
// record's params reference the wire type of every field.  When a value
// object `Outer` has a field of value-object type `Inner`, `OuterResponse`
// has an `InnerResponse` param — so `Inner` must be emitted too.  The
// collector previously walked only the types named directly on the
// aggregate, so a VO nested inside another VO (and not used directly by
// the aggregate) was missed and the project failed to compile on the
// dangling `InnerResponse` reference.  Backend-side twin of the
// React/Hono `<Enum>Schema` fixes.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  valueobject Inner { code: string }
  valueobject Outer { label: string  inner: Inner }

  context Sales {
    aggregate Customer {
      name: string
      box: Outer
    }
    repository Customers for Customer {}
  }
`;

function joinAll(files: Map<string, string>, suffix: string): string {
  return [...files.entries()]
    .filter(([k]) => k.endsWith(suffix))
    .map(([, v]) => v)
    .join("\n");
}

describe(".NET DTOs — value object nested in a value object", () => {
  it("emits the nested VO's Response + Request records", async () => {
    const files = generateDotnet(await parseValid(SRC));

    // Assert the record DECLARATIONS, not bare name references: a missing
    // `Inner` still leaves `InnerResponse` as OuterResponse's param TYPE,
    // so the dangling reference only shows as an absent `record` decl.
    const responses = joinAll(files, "Responses/CustomerResponses.cs");
    expect(responses, "CustomerResponses.cs not emitted").not.toBe("");
    expect(responses).toContain("record OuterResponse(");
    // Inner is reached only through Outer.inner — its record must still be declared.
    expect(responses).toContain("record InnerResponse(");

    const requests = joinAll(files, "Requests/CustomerRequests.cs");
    expect(requests, "CustomerRequests.cs not emitted").not.toBe("");
    expect(requests).toContain("record OuterRequest(");
    expect(requests).toContain("record InnerRequest(");
  });
});
