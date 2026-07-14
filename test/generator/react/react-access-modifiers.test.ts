// React integration test for field-access modifiers — exercises the
// `forApiRead` / `forCreateInput` filters through the React api-
// builder which emits client-side Zod schemas for requests and
// responses.  Companion to `test/ir/wire-projection.test.ts`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

async function gen(src: string): Promise<Map<string, string>> {
  return generateSystemFiles(src);
}

const FIXTURE = `
system Demo {
  subdomain M {
    context Accounts {
      aggregate Account with crudish {
        handle: string
        slug: string immutable
        passwordHash: string secret
        loginCount: int managed
        version: int token
        adminNotes: string internal
      }
      repository Accounts for Account { }
    }
  }
  ui Web {
    page Home { body: Text("hi") }
  }
  deployable api { platform: node, contexts: [Accounts], port: 3000 }
  deployable web { platform: react, contexts: [Accounts], targets: api, ui: Web, port: 3001 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

describe("React generator — field access modifiers", () => {
  it("AccountResponse Zod excludes `internal` and `secret`", async () => {
    const files = await gen(FIXTURE);
    // Inside the React deployable, search for the file emitting the
    // response Zod schema (e.g. an api/<module> client file).
    const apiCode = findFile(files, /web\/.*api.*\/(account|index)\.ts/);
    expect(apiCode, "React api client file should exist").toBeDefined();
    const respBlock =
      (apiCode ?? "").match(/AccountResponse\s*=\s*z\.object\(\{[\s\S]*?\}\)/)?.[0] ?? "";
    expect(respBlock, "AccountResponse Zod block must be located").not.toEqual("");
    expect(respBlock).toMatch(/handle/);
    expect(respBlock).toMatch(/slug/);
    expect(respBlock, "secret must not be in response Zod").not.toMatch(/passwordHash/);
    expect(respBlock, "internal must not be in response Zod").not.toMatch(/adminNotes/);
  });

  it("CreateAccountRequest Zod includes immutable/secret, excludes managed/token/internal", async () => {
    const files = await gen(FIXTURE);
    const apiCode = findFile(files, /web\/.*api.*\/(account|index)\.ts/);
    expect(apiCode).toBeDefined();
    // Locate the CreateAccountRequest schema explicitly.
    const reqBlock =
      (apiCode ?? "").match(/CreateAccountRequest\s*=\s*z\.object\(\{[\s\S]*?\n\}\)/)?.[0] ?? "";
    expect(reqBlock, "CreateAccountRequest block must be located").not.toEqual("");
    expect(reqBlock, "handle in Create").toMatch(/handle/);
    expect(reqBlock, "slug (immutable) in Create").toMatch(/slug/);
    expect(reqBlock, "passwordHash (secret) in Create").toMatch(/passwordHash/);
    expect(reqBlock, "loginCount (managed) NOT in Create").not.toMatch(/loginCount/);
    expect(reqBlock, "version (token) NOT in Create").not.toMatch(/version/);
    expect(reqBlock, "adminNotes (internal) NOT in Create").not.toMatch(/adminNotes/);
  });
});
