// AST-level tenancy declaration checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/plans/multi-tenancy-implementation.md §1): duplicate `tenancy by`
// declarations and the claim-field-exists rule (the tenancy twin of
// `loom.auth-unknown-claim-field`).  The registry/stance checks need the
// merged IR and are covered by `test/ir/tenancy-checks.test.ts`.

import { describe, expect, it } from "vitest";
import { parseString } from "../../_helpers/parse.js";

describe("tenancy by — AST validation", () => {
  it("flags a second `tenancy by` declaration (loom.tenancy-duplicate)", async () => {
    const { errors } = await parseString(`
      system Billder {
        user { id: guid  tenantId: string  orgId: string }
        tenancy by user.tenantId of Organization
        tenancy by user.orgId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(errors.some((e) => /more than one 'tenancy by' line/.test(e))).toBe(true);
    // Only the extra is flagged — exactly one duplicate error for two decls.
    expect(errors.filter((e) => /more than one 'tenancy by'/.test(e))).toHaveLength(1);
  });

  it("flags a claim that is not a user field (loom.tenancy-unknown-claim)", async () => {
    const { errors } = await parseString(`
      system Billder {
        user { id: guid  email: string }
        tenancy by user.orgId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(errors.some((e) => /tenancy claim targets unknown user field 'orgId'/.test(e))).toBe(
      true,
    );
  });

  it("flags a tenancy declaration without any user block (same code, user-block message)", async () => {
    const { errors } = await parseString(`
      system Billder {
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(
      errors.some((e) =>
        /'tenancy by user.tenantId' requires a `user { … }` block declaring field 'tenantId'/.test(
          e,
        ),
      ),
    ).toBe(true);
  });

  it("accepts a single tenancy declaration whose claim is a declared user field", async () => {
    const { errors } = await parseString(`
      system Billder {
        user { id: guid  email: string  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization { name: string }
            aggregate Invoice with tenantOwned { number: string }
            repository Organizations for Organization { }
            repository Invoices for Invoice { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});
