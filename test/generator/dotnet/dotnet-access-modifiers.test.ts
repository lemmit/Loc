// .NET integration test for field-access modifiers — exercises the
// `forApiRead` / `forCreateInput` filters through the actual .NET
// generator pipeline.  Companion to the IR-level unit tests in
// `test/ir/wire-projection.test.ts`; here we verify the generator
// produces the right C# DTO record params + the right
// Create<Agg>Request shape.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../../src/generator/dotnet/index.js";
import { parseString } from "../../_helpers/index.js";

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("; "));
  return generateDotnet(model);
}

// Legacy single-context mode — `generateDotnet(model)` walks
// top-level contexts directly.  System+module wrapping uses
// `generateSystems` which is exercised elsewhere; the access-modifier
// filter is at the dto-mapping/cqrs-emit layer so either entry point
// is sufficient to verify the filtering.
const FIXTURE = `
context Accounts {
  aggregate Account {
    handle: string
    slug: string immutable
    passwordHash: string secret
    loginCount: int managed
    version: int token
    adminNotes: string internal
    create(handle: string) { handle := handle }
  }
  repository Accounts for Account { }
}
`;

describe(".NET generator — field access modifiers", () => {
  it("AccountResponse record excludes `internal` and `secret`", async () => {
    const files = await gen(FIXTURE);
    const dto = files.get("Application/Accounts/Responses/AccountResponses.cs");
    expect(dto, "AccountResponses.cs should be emitted").toBeDefined();
    // Visible in API reads:
    expect(dto).toMatch(/string Handle/);
    expect(dto).toMatch(/string Slug/);
    expect(dto).toMatch(/int LoginCount/);
    expect(dto).toMatch(/int Version/);
    // Excluded from API reads:
    expect(dto, "secret field must not be in response").not.toMatch(/PasswordHash/);
    expect(dto, "internal field must not be in response").not.toMatch(/AdminNotes/);
  });

  it("CreateAccountRequest excludes `managed`, `token`, `internal` but keeps `immutable` + `secret`", async () => {
    const files = await gen(FIXTURE);
    const req = files.get("Application/Accounts/Requests/AccountRequests.cs");
    expect(req, "AccountRequests.cs should be emitted").toBeDefined();
    // Editable + immutable + secret remain (these are required client input):
    expect(req).toMatch(/Handle/);
    expect(req).toMatch(/Slug/);
    expect(req).toMatch(/PasswordHash/);
    // Server-controlled fields removed from create request.  The
    // matcher is anchored so we don't trip on the (unrelated) `Version`
    // file/header line or on any non-record mention.
    const createReq = (req ?? "").match(/record\s+CreateAccountRequest\s*\(([^)]*)\)/)?.[1] ?? "";
    expect(createReq, "managed field must not be in CreateAccountRequest").not.toMatch(
      /LoginCount/,
    );
    expect(createReq, "token field must not be in CreateAccountRequest").not.toMatch(/Version/);
    expect(createReq, "internal field must not be in CreateAccountRequest").not.toMatch(
      /AdminNotes/,
    );
  });

  it("CreateAccountHandler passes only access-permitted args to Account.Create", async () => {
    const files = await gen(FIXTURE);
    const handler = files.get("Application/Accounts/Commands/CreateAccountHandler.cs");
    expect(handler, "CreateAccountHandler.cs should be emitted").toBeDefined();
    // The handler must call Account.Create(...) with create-input
    // fields only.  If the filter at cqrs-emit:57 didn't apply, the
    // handler would try to pass LoginCount / Version / AdminNotes and
    // the generated C# would not compile.
    expect(handler, "managed field must not be passed to Create").not.toMatch(/LoginCount/);
    expect(handler, "token field must not be passed to Create").not.toMatch(/Version/);
    expect(handler, "internal field must not be passed to Create").not.toMatch(/AdminNotes/);
  });
});
