// TS/Hono integration test for field-access modifiers — exercises
// the `forApiRead` / `forCreateInput` filters through the actual
// Hono route emitter and the repository's `toWire` serializer.
// Companion to the IR-level unit tests in `test/ir/wire-projection.test.ts`.

import { describe, expect, it } from "vitest";
import { generateHono, parseString } from "../../_helpers/index.js";

async function gen(src: string): Promise<Map<string, string>> {
  const { model, errors } = await parseString(src);
  if (errors.length) throw new Error(errors.join("; "));
  return generateHono(model);
}

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

describe("TS/Hono generator — field access modifiers", () => {
  it("toWire serializer excludes `internal` and `secret` from response", async () => {
    const files = await gen(FIXTURE);
    const repo = files.get("db/repositories/account-repository.ts");
    expect(repo, "account-repository.ts should be emitted").toBeDefined();
    // Locate the toWire body specifically — repository file may
    // contain field names in other contexts (column maps, etc.).
    const toWire = (repo ?? "").match(/toWire\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(toWire, "handle (editable) projected").toMatch(/handle/);
    expect(toWire, "slug (immutable) projected").toMatch(/slug/);
    expect(toWire, "passwordHash (secret) must NOT be in response").not.toMatch(/passwordHash/);
    expect(toWire, "adminNotes (internal) must NOT be in response").not.toMatch(/adminNotes/);
  });

  it("CreateAccountRequest Zod schema includes immutable/secret, excludes managed/token/internal", async () => {
    const files = await gen(FIXTURE);
    const routes = files.get("http/account.routes.ts");
    expect(routes, "account.routes.ts should be emitted").toBeDefined();
    // Locate the CreateAccountRequest schema block specifically —
    // ends at the closing call to .openapi("CreateAccountRequest").
    const createReq =
      (routes ?? "").match(
        /const CreateAccountRequest[\s\S]*?\.openapi\("CreateAccountRequest"\)/,
      )?.[0] ?? "";
    expect(createReq, "block must be located").not.toEqual("");
    // Required client input remains:
    expect(createReq, "handle in Create request").toMatch(/handle/);
    expect(createReq, "slug (immutable) in Create request").toMatch(/slug/);
    expect(createReq, "passwordHash (secret) in Create request").toMatch(/passwordHash/);
    // Server-controlled fields removed:
    expect(createReq, "loginCount (managed) NOT in Create request").not.toMatch(/loginCount/);
    expect(createReq, "version (token) NOT in Create request").not.toMatch(/version/);
    expect(createReq, "adminNotes (internal) NOT in Create request").not.toMatch(/adminNotes/);
  });

  it("create factory seeds server-managed non-optional fields with a type-correct value, not null", async () => {
    // A `datetime managed` (server-stamped, non-optional) field must not be
    // initialised to `null` in the all-fields ctor state literal — `null`
    // against a non-nullable `Date` is a tsc error.  It seeds `new Date()`;
    // a managed `int` seeds `0`.  (An *optional* managed field stays null.)
    const files = await gen(`
      context Orders {
        aggregate Order {
          reference: string
          placedAt: datetime managed
          loginCount: int managed
          closedAt: datetime? managed
          create(reference: string) { reference := reference }
        }
        repository Orders for Order { }
      }
    `);
    const domain = files.get("domain/order.ts") ?? "";
    const create = domain.match(/static create\([\s\S]*?\n {2}\}/)?.[0] ?? "";
    expect(create, "create factory block must be located").not.toEqual("");
    expect(create, "managed datetime seeds new Date()").toMatch(/placedAt:\s*new Date\(\)/);
    expect(create, "managed int seeds 0").toMatch(/loginCount:\s*0/);
    expect(create, "optional managed datetime stays null").toMatch(/closedAt:\s*null/);
    expect(create, "managed datetime must NOT seed null").not.toMatch(/placedAt:\s*null/);
  });
});
