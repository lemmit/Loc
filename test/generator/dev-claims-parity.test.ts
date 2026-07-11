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
