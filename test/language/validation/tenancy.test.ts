// AST-level tenancy declaration checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/old/plans/multi-tenancy-implementation.md §1): duplicate `tenancy by`
// declarations, plus the LINKING errors that replaced the existence checks
// in 1b.1 — the claim / registry bindings are real cross-references now, so
// an unknown user field or aggregate is a parse-level "Could not resolve
// reference …" diagnostic (formerly `loom.tenancy-unknown-claim` /
// `loom.tenancy-registry-unknown`).  The stance checks need the merged IR
// and are covered by `test/ir/tenancy-checks.test.ts`.

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

  it("a claim that is not a user field is a linking error (cross-ref since 1b.1)", async () => {
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
    expect(
      errors.some((e) => /Could not resolve reference to UserField named 'orgId'/.test(e)),
    ).toBe(true);
  });

  it("a tenancy declaration without any user block is a linking error on the claim", async () => {
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
    // No `user { … }` block ⇒ the claim scope is empty ⇒ the reference
    // cannot link.  Same fix as before: declare the claim field.
    expect(
      errors.some((e) => /Could not resolve reference to UserField named 'tenantId'/.test(e)),
    ).toBe(true);
  });

  it("a registry naming no aggregate is a linking error (cross-ref since 1b.1)", async () => {
    const { errors } = await parseString(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Invoicing {
            aggregate Invoice with tenantOwned { number: string }
            repository Invoices for Invoice { }
          }
        }
      }
    `);
    expect(
      errors.some((e) => /Could not resolve reference to Aggregate named 'Organization'/.test(e)),
    ).toBe(true);
  });

  it("does not offer user fields outside the tenancy claim position (targeted scope)", async () => {
    // A bare user-field name in a type position must NOT resolve to the
    // `user { … }` field — the scope arm is claim-slot-only.
    const { errors } = await parseString(`
      system Billder {
        user { id: guid  tenantId: string }
        subdomain Billing {
          context Accounts {
            aggregate Organization { field: tenantId }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(errors.some((e) => /Could not resolve reference/.test(e))).toBe(true);
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

// ---------------------------------------------------------------------------
// `currentUser.orgPath` — the derived tenant materialized-path principal
// member (multi-tenancy Phase 2, plan P2.1).  It is only meaningful under a
// `tenancy by` declaration (it resolves from the tenancy claim + registry);
// referencing it without one is fail-closed (`loom.orgpath-without-tenancy`).
// ---------------------------------------------------------------------------

describe("currentUser.orgPath — AST validation", () => {
  it("accepts `currentUser.orgPath` under a tenancy declaration", async () => {
    const { errors } = await parseString(`
      system Shop {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain S {
          context C {
            aggregate Doc with tenantOwned {
              owner: string
              filter this.owner == currentUser.orgPath
            }
            aggregate Org { name: string }
            repository Docs for Doc { }
            repository Orgs for Org { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects `currentUser.orgPath` without a tenancy declaration (loom.orgpath-without-tenancy)", async () => {
    const { diagnostics } = await parseString(`
      system Shop {
        user { id: guid  tenantId: string }
        subdomain S {
          context C {
            aggregate Doc {
              owner: string
              filter this.owner == currentUser.orgPath
            }
            repository Docs for Doc { }
          }
        }
      }
    `);
    expect(diagnostics.some((d) => d.code === "loom.orgpath-without-tenancy")).toBe(true);
  });

  it("accepts `currentUser.rootOrg` under a tenancy declaration (P2.5)", async () => {
    const { errors } = await parseString(`
      system Shop {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain S {
          context C {
            aggregate Doc with tenantOwned {
              owner: string
              filter this.owner == currentUser.rootOrg
            }
            aggregate Org { name: string }
            repository Docs for Doc { }
            repository Orgs for Org { }
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects `currentUser.rootOrg` without a tenancy declaration (loom.orgpath-without-tenancy)", async () => {
    const { diagnostics } = await parseString(`
      system Shop {
        user { id: guid  tenantId: string }
        subdomain S {
          context C {
            aggregate Doc {
              owner: string
              filter this.owner == currentUser.rootOrg
            }
            repository Docs for Doc { }
          }
        }
      }
    `);
    expect(diagnostics.some((d) => d.code === "loom.orgpath-without-tenancy")).toBe(true);
  });
});
