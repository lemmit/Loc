// Dev-auth-stub `x-loom-dev-claims` parity across all five backends.
//
// When a deployable sets `auth: required` but the system declares no OIDC
// block, each backend emits a permissive DEV STUB verifier so the stack boots
// out of the box.  Historically only the Hono stub honoured an injected
// `x-loom-dev-claims` header (base64-JSON merged over the built-in identity) —
// the .NET/Java/Python/Elixir stubs returned a hard-coded admin and ignored
// the request.  That gap made a cross-tenant isolation e2e node-only (you
// cannot drive a distinct tenant per request without it).  This pins the
// parity: every backend's dev stub must read the header.
//
// Scope: string-typed claims only (the tenant-claim case) — a JSON string maps
// cleanly onto the principal's field; non-string fields keep their stub value.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const system = (platform: string) => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain Sales {
      context Ordering {
        aggregate Invoice with tenantOwned { number: string }
        aggregate Organization { name: string }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
      auth: required
    }
  }
`;

const allFiles = async (platform: string): Promise<string> => {
  const files = await generateSystemFiles(system(platform));
  return [...files.values()].join("\n\n");
};

describe("dev-auth-stub x-loom-dev-claims injection parity", () => {
  for (const platform of ["node", "dotnet", "python", "java", "elixir"]) {
    it(`${platform}: dev stub reads the x-loom-dev-claims header`, async () => {
      expect(await allFiles(platform)).toContain("x-loom-dev-claims");
    });
  }
});

// The BUILT-IN identity the header above merges over (#2548).
//
// `/api/auth/me` is a contract over the DECLARED `user { … }` shape — it is what
// the generated frontends' `auth: ui` guard reads — so the dev stub must fill
// every field the block declares, and a non-optional field must never answer
// null.  Elixir used to return a fixed `%{"id", "role", "permissions"}` claim
// map that `build_user/1` then read by declared field name: a field NAMED
// `role` got "admin" by coincidence and every other declared field (the
// `tenantId` of every tenancy system among them) came back nil, while the other
// four backends filled it.  Neither half of that is derivable from the shape,
// which is why this pins the whole identity rather than the presence of a key.
//
// The value table is shared by all five: string → "admin", guid → the zero
// uuid, int/long → 0, decimal/money → zero, bool → false, datetime → the epoch,
// array → EMPTY (a permission-guarded surface denies by default), optional →
// null.  A backend's own rendering of it is per-language, so each arm pins the
// construction site verbatim (whitespace-normalised).
const identitySystem = (platform: string) => `
  system Shop {
    user { id: guid  role: string  tenantId: string }
    subdomain Sales {
      context Ordering {
        aggregate Invoice { number: string }
        repository Invoices for Invoice { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api {
      platform: ${platform}
      contexts: [Ordering]
      dataSources: [ordState]
      serves: SalesApi
      port: 3001
      auth: required
    }
  }
`;

/** Collapse runs of whitespace so an arm pins the VALUES, not the emitter's
 *  line wrapping. */
const squash = (s: string) => s.replace(/\s+/g, " ");

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** The built-in stub identity for `user { id: guid  role: string  tenantId: string }`,
 *  as each backend spells it. */
const STUB_IDENTITY: Record<string, string> = {
  node: `id: "${ZERO_UUID}", role: "admin", tenantId: "admin",`,
  dotnet: `Id: System.Guid.Empty, Role: "admin", TenantId: "admin")`,
  python: `User(id="${ZERO_UUID}", role="admin", tenant_id="admin")`,
  java: `return new User(new UUID(0L, 0L), "admin", "admin");`,
  elixir: `"id" => "${ZERO_UUID}", "role" => "admin", "tenant_id" => "admin"`,
};

describe("dev-auth-stub built-in identity fills the declared user shape", () => {
  for (const [platform, identity] of Object.entries(STUB_IDENTITY)) {
    it(`${platform}: every declared user field carries a stub value`, async () => {
      const files = await generateSystemFiles(identitySystem(platform));
      expect(squash([...files.values()].join("\n\n"))).toContain(squash(identity));
    });
  }
});
