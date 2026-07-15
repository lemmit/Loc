// Derived registry self-scope filter (multi-tenancy Phase 1b, capstone
// decision 4 — docs/old/proposals/multi-tenancy-design-note.md): under
// `tenancy by user.<claim> of <Registry>`, enrichment appends
// `this.id == currentUser.<claim>` to the registry's `contextFilters`
// (origin `TENANCY_SELF_SCOPE_ORIGIN`) — the `tenantId ≡ <Registry>.id`
// identity, DERIVED from the declaration, never written by the author.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import { TENANCY_SELF_SCOPE_ORIGIN, tenancyClaimBinding } from "../../src/ir/util/tenant-stance.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

function findAgg(ir: LoomModel, name: string): AggregateIR {
  for (const s of ir.systems) {
    for (const m of s.subdomains) {
      for (const c of m.contexts) {
        for (const a of c.aggregates) if (a.name === name) return a;
      }
    }
  }
  throw new Error(`aggregate ${name} not found in IR`);
}

const TENANCY_SRC = `
  system Billder {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Organization
    subdomain Billing {
      context Invoicing {
        aggregate Invoice with tenantOwned { number: string }
        crossTenant aggregate Plan { code: string }
        repository Invoices for Invoice { }
      }
      context Accounts {
        aggregate Organization { name: string }
        repository Organizations for Organization { }
      }
    }
  }
`;

describe("registry self-scope filter (enrichment derivation)", () => {
  it("synthesizes `this.id == currentUser.<claim>` on the registry, fully resolved", async () => {
    const ir = await buildLoomModel(TENANCY_SRC);
    const org = findAgg(ir, "Organization");
    expect(org.contextFilters).toHaveLength(1);
    expect(org.contextFilterOrigins).toEqual([TENANCY_SELF_SCOPE_ORIGIN]);
    const pred = org.contextFilters![0]!;
    // The exact resolved shape every backend's principal-filter path consumes.
    expect(pred).toMatchObject({
      kind: "binary",
      op: "==",
      left: {
        kind: "member",
        receiver: { kind: "this" },
        member: "id",
        receiverType: { kind: "entity", name: "Organization" },
        memberType: { kind: "id", targetName: "Organization", valueType: "guid" },
      },
      right: {
        kind: "member",
        receiver: { kind: "ref", name: "currentUser", refKind: "current-user" },
        member: "tenantId",
        // Typed TRUTHFULLY as the claim's declared type — the guid binding
        // happens per backend at the accessor site (option C).
        memberType: { kind: "primitive", name: "string" },
      },
      resultType: { kind: "primitive", name: "bool" },
    });
  });

  it("derives nothing on tenantOwned / crossTenant aggregates beyond their own filters", async () => {
    const ir = await buildLoomModel(TENANCY_SRC);
    const invoice = findAgg(ir, "Invoice");
    // tenantOwned's own capability filter only — no self-scope entry.
    expect(invoice.contextFilterOrigins).toEqual(["tenantOwned"]);
    const plan = findAgg(ir, "Plan");
    expect(plan.contextFilters).toBeUndefined();
  });

  it("derives nothing without a `tenancy by` declaration (same-named aggregate)", async () => {
    const ir = await buildLoomModel(`
      system Plain {
        user { id: guid  tenantId: string }
        subdomain Core {
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    expect(findAgg(ir, "Organization").contextFilters).toBeUndefined();
  });

  it("keeps a hand-written registry filter and appends the derived one after it", async () => {
    const ir = await buildLoomModel(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization {
              name: string
              active: bool
              filter this.active
            }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    const org = findAgg(ir, "Organization");
    expect(org.contextFilters).toHaveLength(2);
    expect(org.contextFilterOrigins).toEqual([undefined, TENANCY_SELF_SCOPE_ORIGIN]);
  });

  it("is idempotent — a second enrichment pass appends nothing", async () => {
    const { model } = await parseString(TENANCY_SRC, { validate: false });
    const once = enrichLoomModel(lowerModel(model));
    const twice = enrichLoomModel(once);
    expect(findAgg(twice, "Organization").contextFilters).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it("derives nothing on a claim-type mismatch (the validator owns the rejection)", async () => {
    const { model } = await parseString(TENANCY_SRC.replace("tenantId: string", "tenantId: int"), {
      validate: false,
    });
    const ir = enrichLoomModel(lowerModel(model));
    expect(findAgg(ir, "Organization").contextFilters).toBeUndefined();
    const diags = validateLoomModel(ir);
    expect(diags.some((d) => d.code === "loom.tenancy-claim-type-mismatch")).toBe(true);
  });

  it("binds a guid claim same-typed (guid registry id + `tenantId: guid`)", async () => {
    const ir = await buildLoomModel(TENANCY_SRC.replace("tenantId: string", "tenantId: guid"));
    const org = findAgg(ir, "Organization");
    expect(org.contextFilters).toHaveLength(1);
    const pred = org.contextFilters![0]!;
    expect(pred).toMatchObject({
      kind: "binary",
      right: { member: "tenantId", memberType: { kind: "primitive", name: "guid" } },
    });
  });
});

describe("tenancyClaimBinding", () => {
  it("classifies the id/claim type link", () => {
    expect(tenancyClaimBinding("guid", { kind: "primitive", name: "guid" })).toBe("same");
    expect(tenancyClaimBinding("guid", { kind: "primitive", name: "string" })).toBe(
      "guid-from-string",
    );
    expect(tenancyClaimBinding("string", { kind: "primitive", name: "string" })).toBe("same");
    expect(tenancyClaimBinding("guid", { kind: "primitive", name: "int" })).toBe("mismatch");
    expect(tenancyClaimBinding("string", { kind: "primitive", name: "guid" })).toBe("mismatch");
    expect(tenancyClaimBinding("int", undefined)).toBe("mismatch");
  });
});

describe("loom.tenancy-claim-type-mismatch", () => {
  it("errors with the suggested fix when the claim can't bind against the registry id", async () => {
    const { model } = await parseString(TENANCY_SRC.replace("tenantId: string", "tenantId: int"), {
      validate: false,
    });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.code === "loom.tenancy-claim-type-mismatch",
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]!.severity).toBe("error");
    expect(diags[0]!.message).toContain("'int'");
    expect(diags[0]!.message).toContain("guid id");
    expect(diags[0]!.message).toContain("tenantId: guid");
  });

  it("does not fire for the supported guid-id + string-claim binding", async () => {
    const { model } = await parseString(TENANCY_SRC, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.filter((d) => d.code === "loom.tenancy-claim-type-mismatch")).toHaveLength(0);
  });
});

describe("registry filter trips the principal-filter auth gate", () => {
  it("errors loom.context-filter-unsupported when the hosting deployable has no auth", async () => {
    const { model } = await parseString(
      `
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Organization
        subdomain Billing {
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
        api BillingApi from Billing
        storage primary { type: postgres }
        resource accountsState { for: Accounts, kind: state, use: primary }
        deployable d {
          platform: node
          contexts: [Accounts]
          dataSources: [accountsState]
          serves: BillingApi
          port: 4000
        }
      }
    `,
      { validate: false },
    );
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.code === "loom.context-filter-unsupported",
    );
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("Organization");
    expect(diags[0]!.message).toContain("auth");
  });
});
