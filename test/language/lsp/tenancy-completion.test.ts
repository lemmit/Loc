// LSP completion for the tenancy claim slot (multi-tenancy 1b.1).
//
// `tenancy by user.<claim>` is a real `[UserField:UserFieldName]`
// cross-reference since 1b.1, so the DEFAULT completion provider walks the
// scope provider — the targeted `ddd-scope.ts` arm that exposes the system's
// `user { … }` fields in that position gives field-name completion for free.
// This pins it (and would catch a scope-arm regression that silently turned
// the slot back into a bare token).

import { NodeFileSystem } from "langium/node";
import { expectCompletion } from "langium/test";
import { describe, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";

// Fresh services per call so the workspace holds exactly one document.
function freshServices() {
  return createDddServices(NodeFileSystem).Ddd;
}

describe("tenancy claim LSP completion (multi-tenancy 1b.1)", () => {
  it("offers the user-field names after `tenancy by user.`", async () => {
    const text = `
system Billder {
  user { id: guid  email: string  tenantId: string }
  tenancy by user.<|>tenantId of Organization
  subdomain Billing { context Accounts {
    aggregate Organization { name: string }
    repository Organizations for Organization { }
  }}
}
`;
    const completion = expectCompletion(freshServices());
    await completion({
      text,
      index: 0,
      expectedItems: ["id", "email", "tenantId"],
      disposeAfterCheck: true,
    });
  });
});
