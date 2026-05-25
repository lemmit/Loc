// Phoenix LiveView integration test for field-access modifiers —
// exercises the `forApiRead` / `forCreateInput` filters through the
// Phoenix OpenAPI schema emitter.  Companion to
// `test/ir/wire-projection.test.ts`.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

async function gen(src: string): Promise<Map<string, string>> {
  return generateSystemFiles(src);
}

const FIXTURE = `
system Demo {
  module M {
    context Accounts {
      aggregate Account {
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
  api AccountsApi from Accounts
  deployable phoenixApp {
    platform: phoenixLiveView
    modules: M
    serves: AccountsApi
    port: 4000
  }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

describe("Phoenix generator — field access modifiers", () => {
  it("AccountResponse OpenAPI schema excludes `internal` and `secret`", async () => {
    const files = await gen(FIXTURE);
    // Locate the per-aggregate response schema Elixir module.
    const resp = findFile(files, /api\/schemas\/account_response\.ex$|AccountResponse\.ex$/i);
    expect(resp, "AccountResponse module should be emitted").toBeDefined();
    expect(resp, "handle (editable) in response schema").toMatch(/handle/);
    expect(resp, "slug (immutable) in response schema").toMatch(/slug/);
    expect(resp, "loginCount (managed) in response schema").toMatch(/login_count|loginCount/);
    expect(resp, "version (token) in response schema").toMatch(/version/);
    expect(resp, "passwordHash (secret) must NOT be in response").not.toMatch(
      /password_hash|passwordHash/,
    );
    expect(resp, "adminNotes (internal) must NOT be in response").not.toMatch(
      /admin_notes|adminNotes/,
    );
  });

  it("CreateAccountRequest OpenAPI schema excludes managed/token/internal", async () => {
    const files = await gen(FIXTURE);
    const req = findFile(
      files,
      /api\/schemas\/create_account_request\.ex$|CreateAccountRequest\.ex$/i,
    );
    expect(req, "CreateAccountRequest module should be emitted").toBeDefined();
    // Required client input remains:
    expect(req, "handle in Create request").toMatch(/handle/);
    expect(req, "slug (immutable) in Create request").toMatch(/slug/);
    expect(req, "passwordHash (secret) in Create request").toMatch(/password_hash|passwordHash/);
    // Server-controlled fields removed:
    expect(req, "loginCount (managed) NOT in Create request").not.toMatch(/login_count|loginCount/);
    expect(req, "version (token) NOT in Create request").not.toMatch(/version/);
    expect(req, "adminNotes (internal) NOT in Create request").not.toMatch(
      /admin_notes|adminNotes/,
    );
  });
});
