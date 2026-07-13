// IR-level tenancy checks (multi-tenancy Phase 1a, slice 1a.3 —
// docs/old/plans/multi-tenancy-implementation.md §1): the explicit-stance lint
// (registry + abstract exemptions), stance markers without a `tenancy by`
// declaration, and conflicting markers.  Stance is derived per aggregate via
// `classifyTenantStance` (derive-don't-stamp).  Registry existence is the
// LINKER's job since 1b.1 (`of` is a real `[Aggregate:ID]` cross-reference —
// covered in `test/language/validation/tenancy.test.ts`), so there is no
// `loom.tenancy-registry-unknown` code any more.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { classifyTenantStance } from "../../src/ir/util/tenant-stance.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

const TENANCY_CODES = new Set([
  "loom.tenancy-stance-unmarked",
  "loom.tenant-owned-without-tenancy",
  "loom.cross-tenant-without-tenancy",
  "loom.tenancy-conflicting-stance",
  "loom.tenancy-registry-marked",
  "loom.tenant-owned-claim-type",
  "loom.tenant-registry-without-tenancy",
  "loom.tenancy-registry-duplicate",
  "loom.tenancy-registry-not-target",
]);

async function tenancyDiags(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
    (d) => d.code !== undefined && TENANCY_CODES.has(d.code),
  );
}

describe("registry existence is the linker's job (1b.1) — no IR code fires", () => {
  it("an unknown `of <Registry>` produces zero IR-level tenancy diagnostics", async () => {
    // The unresolved `[Aggregate:ID]` cross-reference is a parse-level
    // "Could not resolve reference to Aggregate named 'Organization'."
    // (asserted in test/language/validation/tenancy.test.ts); lowering
    // stays total via the `$refText` fallback and no themed code fires.
    const diags = await tenancyDiags(`
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
    expect(diags).toEqual([]);
  });
});

describe("loom.tenancy-stance-unmarked", () => {
  it("errors on an unmarked aggregate under a `tenancy by` system, suggesting the fix", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Invoicing {
            aggregate Shipment { code: string }
            aggregate Organization { name: string }
            repository Shipments for Shipment { }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "error",
      code: "loom.tenancy-stance-unmarked",
      source: "Invoicing/Shipment",
    });
    expect(diags[0]!.message).toContain(
      "aggregate 'Shipment' declares no tenancy stance; add `with tenantOwned` (tenant data) or `crossTenant` (shared data)",
    );
  });

  it("exempts abstract bases; the requirement falls on the concretes", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Invoicing {
            abstract aggregate Document { title: string }
            aggregate Invoice extends Document { number: string }
            aggregate Organization { name: string }
            repository Invoices for Invoice { }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    // The abstract base is exempt; the unmarked concrete is not.
    expect(diags.map((d) => [d.code, d.source])).toEqual([
      ["loom.tenancy-stance-unmarked", "Invoicing/Invoice"],
    ]);
  });

  it("does not fire on a system without a tenancy declaration", async () => {
    const diags = await tenancyDiags(`
      system Plain {
        subdomain M {
          context C {
            aggregate Order { subject: string }
            repository Orders for Order { }
          }
        }
      }
    `);
    expect(diags).toEqual([]);
  });
});

describe("stance markers without a tenancy declaration", () => {
  it("errors on `with tenantOwned` without `tenancy by` (loom.tenant-owned-without-tenancy)", async () => {
    const diags = await tenancyDiags(`
      system Plain {
        user { id: guid  tenantId: string }
        subdomain M {
          context C {
            aggregate Invoice with tenantOwned { number: string }
            repository Invoices for Invoice { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "error",
      code: "loom.tenant-owned-without-tenancy",
      source: "C/Invoice",
    });
  });

  it("warns on `crossTenant` without `tenancy by` (loom.cross-tenant-without-tenancy)", async () => {
    const diags = await tenancyDiags(`
      system Plain {
        subdomain M {
          context C {
            aggregate Plan crossTenant { code: string }
            repository Plans for Plan { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "warning",
      code: "loom.cross-tenant-without-tenancy",
      source: "C/Plan",
    });
  });
});

describe("loom.tenancy-conflicting-stance", () => {
  it("errors when one aggregate carries both markers", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Invoicing {
            aggregate Invoice crossTenant with tenantOwned { number: string }
            aggregate Organization { name: string }
            repository Invoices for Invoice { }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "error",
      code: "loom.tenancy-conflicting-stance",
      source: "Invoicing/Invoice",
    });
  });
});

describe("loom.tenancy-registry-marked", () => {
  it("errors when the registry is marked crossTenant", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization crossTenant { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "error",
      code: "loom.tenancy-registry-marked",
      source: "Accounts/Organization",
    });
  });

  it("errors when the registry is marked with tenantOwned", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization with tenantOwned { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({
      severity: "error",
      code: "loom.tenancy-registry-marked",
      source: "Accounts/Organization",
    });
  });
});

describe("the plan §1 worked example", () => {
  // Organization registry unmarked + exempt; Plan crossTenant;
  // Invoice/Customer with tenantOwned — zero tenancy diagnostics.
  const WORKED_EXAMPLE = `
    system Billder {
      user { id: guid  email: string  tenantId: string }
      tenancy by user.tenantId of Organization
      subdomain Billing {
        context Catalog {
          aggregate Plan crossTenant { code: string  monthlyPrice: decimal }
          repository Plans for Plan { }
        }
        context Invoicing {
          aggregate Invoice with tenantOwned { number: string  amountDue: decimal }
          aggregate Customer with tenantOwned { name: string  email: string }
          repository Invoices for Invoice { }
          repository Customers for Customer { }
        }
        context Accounts {
          aggregate Organization { name: string  active: bool = true }
          repository Organizations for Organization { }
        }
      }
    }
  `;

  it("produces zero tenancy diagnostics", async () => {
    expect(await tenancyDiags(WORKED_EXAMPLE)).toEqual([]);
  });

  it("classifyTenantStance derives the four stances (derive-don't-stamp)", async () => {
    const ir = await buildLoomModel(WORKED_EXAMPLE);
    const sys = ir.systems[0]!;
    const aggs = sys.subdomains[0]!.contexts.flatMap((c) => c.aggregates);
    const stanceOf = (name: string) =>
      classifyTenantStance(aggs.find((a) => a.name === name)!, sys);
    expect(stanceOf("Plan")).toBe("crossTenant");
    expect(stanceOf("Invoice")).toBe("tenantOwned");
    expect(stanceOf("Customer")).toBe("tenantOwned");
    expect(stanceOf("Organization")).toBe("registry");
  });
});

describe("loom.tenant-owned-claim-type (1b-tail)", () => {
  const sys = (claimType: string, agg: string) => `
    system Billder {
      user { id: guid  tenantId: ${claimType} }
      tenancy by user.tenantId of Organization
      subdomain Billing {
        context Invoicing {
          ${agg}
          aggregate Organization { name: string }
        }
      }
    }
  `;

  it("errors when a tenantOwned aggregate exists under a non-string claim", async () => {
    const diags = await tenancyDiags(
      sys("guid", `aggregate Invoice with tenantOwned { number: string }`),
    );
    const hit = diags.find((d) => d.code === "loom.tenant-owned-claim-type");
    expect(hit?.severity).toBe("error");
    expect(hit?.message).toContain("tenantId: string");
  });

  it("does not fire for a registry-only system with a guid claim (same-typed self-scope)", async () => {
    const diags = await tenancyDiags(sys("guid", `aggregate Plan crossTenant { code: string }`));
    expect(diags.filter((d) => d.code === "loom.tenant-owned-claim-type")).toEqual([]);
  });

  it("does not fire for a string claim with tenantOwned aggregates", async () => {
    const diags = await tenancyDiags(
      sys("string", `aggregate Invoice with tenantOwned { number: string }`),
    );
    expect(diags.filter((d) => d.code === "loom.tenant-owned-claim-type")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tenantRegistry hierarchy capability (multi-tenancy Phase 2, plan P2.2).
// The registry opts into the tree (`parent: Self id?` + managed `dataKey`) by
// carrying `implements tenantRegistry`.  These structural checks verify the
// facts field-presence can't: only under a `tenancy by` system, exactly one
// aggregate, and on the `of <Registry>` target.
// ---------------------------------------------------------------------------

describe("tenantRegistry structural checks", () => {
  it("accepts the registry (the `of` target) carrying `implements tenantRegistry`", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Platform {
          context Accounts {
            aggregate Organization {
              name: string
              implements tenantRegistry
            }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(diags).toEqual([]);
  });

  it("errors when `implements tenantRegistry` has no `tenancy by` line", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        subdomain Platform {
          context Accounts {
            aggregate Organization {
              name: string
              implements tenantRegistry
            }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(diags.map((d) => [d.code, d.source])).toEqual([
      ["loom.tenant-registry-without-tenancy", "Accounts/Organization"],
    ]);
  });

  it("errors when two aggregates implement tenantRegistry", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Platform {
          context Accounts {
            aggregate Organization {
              name: string
              implements tenantRegistry
            }
            aggregate Division {
              name: string
              implements tenantRegistry
            }
            repository Organizations for Organization { }
            repository Divisions for Division { }
          }
        }
      }
    `);
    expect(diags.filter((d) => d.code === "loom.tenancy-registry-duplicate")).toHaveLength(2);
  });

  it("errors when a NON-registry aggregate implements tenantRegistry", async () => {
    const diags = await tenancyDiags(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Platform {
          context Accounts {
            aggregate Organization { name: string }
            aggregate Division {
              name: string
              implements tenantRegistry
            }
            repository Organizations for Organization { }
            repository Divisions for Division { }
          }
        }
      }
    `);
    // Division is also unmarked (no stance), so `loom.tenancy-stance-unmarked`
    // fires alongside — assert the registry-target code specifically.
    expect(diags.filter((d) => d.code === "loom.tenancy-registry-not-target")).toMatchObject([
      { code: "loom.tenancy-registry-not-target", source: "Accounts/Division" },
    ]);
  });
});
