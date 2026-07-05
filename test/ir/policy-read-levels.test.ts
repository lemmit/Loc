// `policy { allow <level> on <Aggregate> }` — the read-reachability ladder
// (authorization.md §3; multi-tenancy Phase 2 P2.4).  Covers lowering
// (`BoundedContextIR.policyReadLevels`), the enrichment rewrite of the
// `tenantOwned` capability filter for a `deep` level, and the phase-⑦
// validator gates.  Stance/level are derived — `local`/`global` keep the flat
// tenant floor unchanged; only `deep` rewrites to the materialized-path
// sentinel.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { ExprIR } from "../../src/ir/types/loom-ir.js";
import { isDeepScopeFilter } from "../../src/ir/util/tenant-stance.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

const hierarchy = (opts: { policy: string; extra?: string }): string => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Invoice with tenantOwned { amount: int }
        aggregate Order with tenantOwned { total: int }
        ${opts.extra ?? ""}
        aggregate Org ids guid {
          name: string
          implements tenantRegistry
        }
        repository Invoices for Invoice { }
        repository Orders for Order { }
        repository Orgs for Org { }
        policy Reach {
          ${opts.policy}
        }
      }
    }
    api ShopApi from S
    storage primarySql { type: postgres }
    resource shopState { for: C, kind: state, use: primarySql }
    deployable api {
      platform: node
      contexts: [C]
      dataSources: [shopState]
      serves: ShopApi
      port: 3001
      auth: required
    }
  }
`;

const POLICY_CODES = new Set([
  "loom.policy-unknown-aggregate",
  "loom.policy-target-not-tenant-owned",
  "loom.policy-level-requires-hierarchy",
  "loom.policy-duplicate-target",
]);

async function policyDiags(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
    (d) => d.code !== undefined && POLICY_CODES.has(d.code),
  );
}

function invoiceFilters(model: Awaited<ReturnType<typeof buildLoomModel>>): {
  invoice: ExprIR[];
  order: ExprIR[];
} {
  const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
  const inv = ctx.aggregates.find((a) => a.name === "Invoice")!;
  const ord = ctx.aggregates.find((a) => a.name === "Order")!;
  return { invoice: inv.contextFilters ?? [], order: ord.contextFilters ?? [] };
}

describe("policy read levels — lowering", () => {
  it("lowers `allow <level> on <Agg>` rules onto BoundedContextIR.policyReadLevels", async () => {
    const model = await buildLoomModel(
      hierarchy({ policy: "allow deep on Invoice\nallow local on Order" }),
    );
    const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
    expect(ctx.policyReadLevels).toEqual([
      { aggregate: "Invoice", level: "deep", source: "allow deep on Invoice" },
      { aggregate: "Order", level: "local", source: "allow local on Order" },
    ]);
  });

  it("a context with no policy carries no policyReadLevels", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "" }));
    expect(model.systems[0]!.subdomains[0]!.contexts[0]!.policyReadLevels).toBeUndefined();
  });
});

describe("policy read levels — enrichment rewrite", () => {
  it("`deep` REPLACES the tenantOwned floor with the materialized-path sentinel", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "allow deep on Invoice" }));
    const { invoice } = invoiceFilters(model);
    // Exactly one filter (the tenantOwned floor), now the deep sentinel.
    expect(invoice.some(isDeepScopeFilter)).toBe(true);
    // The floor's `tenantId ==` binary is gone (replaced, not appended).
    expect(invoice.some((f) => f.kind === "binary")).toBe(false);
  });

  it("`local` and `global` keep the flat tenantId floor unchanged (no sentinel)", async () => {
    for (const level of ["local", "global"] as const) {
      const model = await buildLoomModel(hierarchy({ policy: `allow ${level} on Invoice` }));
      const { invoice } = invoiceFilters(model);
      expect(invoice.some(isDeepScopeFilter)).toBe(false);
      expect(invoice.some((f) => f.kind === "binary")).toBe(true);
    }
  });

  it("only the named aggregate is rewritten; siblings keep the floor", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "allow deep on Invoice" }));
    const { invoice, order } = invoiceFilters(model);
    expect(invoice.some(isDeepScopeFilter)).toBe(true);
    expect(order.some(isDeepScopeFilter)).toBe(false);
    expect(order.some((f) => f.kind === "binary")).toBe(true);
  });

  it("the deep sentinel keeps the `tenantOwned` origin (still `ignoring`-bypassable)", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "allow deep on Invoice" }));
    const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
    const inv = ctx.aggregates.find((a) => a.name === "Invoice")!;
    const i = (inv.contextFilters ?? []).findIndex(isDeepScopeFilter);
    expect(inv.contextFilterOrigins?.[i]).toBe("tenantOwned");
  });
});

describe("policy read levels — validation (fail closed)", () => {
  it("valid `deep`/`global`/`local` under a hierarchy produce no policy diagnostics", async () => {
    const diags = await policyDiags(
      hierarchy({ policy: "allow deep on Invoice\nallow global on Order" }),
    );
    expect(diags).toEqual([]);
  });

  it("unknown aggregate → loom.policy-unknown-aggregate", async () => {
    const diags = await policyDiags(hierarchy({ policy: "allow deep on Ghost" }));
    expect(diags.map((d) => d.code)).toContain("loom.policy-unknown-aggregate");
  });

  it("non-tenantOwned target → loom.policy-target-not-tenant-owned", async () => {
    const diags = await policyDiags(
      hierarchy({
        extra: "aggregate Plan crossTenant { tier: string }",
        policy: "allow deep on Plan",
      }),
    );
    expect(diags.map((d) => d.code)).toContain("loom.policy-target-not-tenant-owned");
  });

  it("duplicate target → loom.policy-duplicate-target", async () => {
    const diags = await policyDiags(
      hierarchy({ policy: "allow deep on Invoice\nallow local on Invoice" }),
    );
    expect(diags.map((d) => d.code)).toContain("loom.policy-duplicate-target");
  });

  it("`deep`/`global` without a tenantRegistry hierarchy → loom.policy-level-requires-hierarchy", async () => {
    // Flat tenancy: registry `Org` does NOT `implements tenantRegistry`.
    const flat = `
      system Flat {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain S {
          context C {
            aggregate Invoice with tenantOwned { amount: int }
            aggregate Org { name: string }
            repository Invoices for Invoice { }
            repository Orgs for Org { }
            policy { allow deep on Invoice }
          }
        }
        api A from S
        storage sql { type: postgres }
        resource st { for: C, kind: state, use: sql }
        deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3001  auth: required }
      }
    `;
    const diags = await policyDiags(flat);
    expect(diags.map((d) => d.code)).toContain("loom.policy-level-requires-hierarchy");
  });

  it("`local` is always valid under flat tenancy (no hierarchy required)", async () => {
    const flat = `
      system Flat {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain S {
          context C {
            aggregate Invoice with tenantOwned { amount: int }
            aggregate Org { name: string }
            repository Invoices for Invoice { }
            repository Orgs for Org { }
            policy { allow local on Invoice }
          }
        }
        api A from S
        storage sql { type: postgres }
        resource st { for: C, kind: state, use: sql }
        deployable api { platform: node  contexts: [C]  dataSources: [st]  serves: A  port: 3001  auth: required }
      }
    `;
    expect(await policyDiags(flat)).toEqual([]);
  });
});
