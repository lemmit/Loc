// `policy { deny [write] on <Aggregate> }` — the DENY-WINS carve-out
// (authorization Phase 4, docs/old/plans/authorization-phase4-deny.md).  Covers
// parsing (the `effect` discriminator), lowering (`BoundedContextIR.policyDenies`),
// the enrichment composition (deny read → always-false term appended to the read
// `contextFilters`; deny write → `writeScopeFilter` set to the sentinel), the
// deny-WINS precedence over a widening allow on the same target, and the phase-⑦
// validator gates.  Deny is all-or-nothing at the aggregate and — unlike the
// allow ladder — is NOT restricted to tenant-owned aggregates.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { isDenyFilter } from "../../src/ir/util/tenant-stance.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { isPolicyDecl } from "../../src/language/generated/ast.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

const hierarchy = (opts: { policy: string; extra?: string }): string => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Invoice with tenantOwned, crudish { amount: int }
        aggregate Order with tenantOwned, crudish { total: int }
        ${opts.extra ?? ""}
        aggregate Org {
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

const DENY_CODES = new Set([
  "loom.policy-deny-unknown-aggregate",
  "loom.policy-deny-duplicate",
  "loom.policy-deny-shadows-allow",
]);

async function denyDiags(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
    (d) => d.code !== undefined && DENY_CODES.has(d.code),
  );
}

function agg(model: Awaited<ReturnType<typeof buildLoomModel>>, name: string): AggregateIR {
  const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
  return ctx.aggregates.find((a) => a.name === name)!;
}

describe("policy deny — parsing", () => {
  it("parses `deny on X` / `deny write on X` with the `effect` discriminator", async () => {
    const { model } = await parseString(
      hierarchy({ policy: "deny on Invoice\ndeny write on Order" }),
      { validate: false },
    );
    const policy = [...AstUtils.streamAllContents(model)].find(isPolicyDecl)!;
    expect(policy.rules.map((r) => ({ effect: r.effect, verb: r.verb, target: r.target }))).toEqual(
      [
        { effect: "deny", verb: undefined, target: "Invoice" },
        { effect: "deny", verb: "write", target: "Order" },
      ],
    );
  });
});

describe("policy deny — lowering", () => {
  it("lowers deny rules onto BoundedContextIR.policyDenies", async () => {
    const model = await buildLoomModel(
      hierarchy({ policy: "deny on Invoice\ndeny write on Order" }),
    );
    const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
    expect(ctx.policyDenies).toEqual([
      { aggregate: "Invoice", access: "read", source: "deny on Invoice" },
      { aggregate: "Order", access: "write", source: "deny write on Order" },
    ]);
  });

  it("a context with no deny carries no policyDenies", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "allow local on Invoice" }));
    expect(model.systems[0]!.subdomains[0]!.contexts[0]!.policyDenies).toBeUndefined();
  });
});

describe("policy deny — enrichment composition", () => {
  it("deny read APPENDS the always-false sentinel to the read filter list", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "deny on Invoice" }));
    const inv = agg(model, "Invoice");
    expect((inv.contextFilters ?? []).some(isDenyFilter)).toBe(true);
    // Read-denied ≠ write-denied: writeScopeFilter is untouched by a deny READ.
    expect(inv.writeScopeFilter && isDenyFilter(inv.writeScopeFilter)).toBeFalsy();
  });

  it("deny write SETS the sentinel as writeScopeFilter and leaves reads alone", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "deny write on Invoice" }));
    const inv = agg(model, "Invoice");
    expect(inv.writeScopeFilter && isDenyFilter(inv.writeScopeFilter)).toBe(true);
    expect((inv.contextFilters ?? []).some(isDenyFilter)).toBe(false);
  });

  it("keeps contextFilterOrigins index-aligned after appending the deny term", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "deny on Invoice" }));
    const inv = agg(model, "Invoice");
    if (inv.contextFilterOrigins) {
      expect(inv.contextFilterOrigins.length).toBe((inv.contextFilters ?? []).length);
      // The deny term carries no capability origin (never `ignoring`-bypassable).
      const i = (inv.contextFilters ?? []).findIndex(isDenyFilter);
      expect(inv.contextFilterOrigins[i]).toBeUndefined();
    }
  });

  it("only the named aggregate is affected; siblings are untouched", async () => {
    const model = await buildLoomModel(hierarchy({ policy: "deny on Invoice" }));
    expect((agg(model, "Order").contextFilters ?? []).some(isDenyFilter)).toBe(false);
  });

  it("DENY WINS: a deny read dominates a widening `allow deep` on the same target", async () => {
    const model = await buildLoomModel(
      hierarchy({ policy: "allow deep on Invoice\ndeny on Invoice" }),
    );
    // The widened read scope is still present, but the always-false term is too,
    // so the conjunction is empty — deny wins.
    expect((agg(model, "Invoice").contextFilters ?? []).some(isDenyFilter)).toBe(true);
  });

  it("works on a NON-tenant-owned aggregate (deny is not gated on tenantOwned)", async () => {
    const model = await buildLoomModel(
      hierarchy({
        extra: "crossTenant aggregate Plan with crudish { tier: string }",
        policy: "deny write on Plan",
      }),
    );
    const plan = agg(model, "Plan");
    expect(plan.writeScopeFilter && isDenyFilter(plan.writeScopeFilter)).toBe(true);
  });

  it("a deny model passes FULL IR validation — the sentinel is queryable", async () => {
    const { model } = await parseString(hierarchy({ policy: "deny on Invoice" }), {
      validate: false,
    });
    const errors = validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
      (d) => d.severity === "error",
    );
    expect(errors).toEqual([]);
  });
});

describe("policy deny — validation", () => {
  it("valid deny rules produce no deny diagnostics", async () => {
    expect(await denyDiags(hierarchy({ policy: "deny on Invoice\ndeny write on Order" }))).toEqual(
      [],
    );
  });

  it("unknown aggregate → loom.policy-deny-unknown-aggregate", async () => {
    const diags = await denyDiags(hierarchy({ policy: "deny on Ghost" }));
    expect(diags.map((d) => d.code)).toContain("loom.policy-deny-unknown-aggregate");
  });

  it("the same (aggregate, access) denied twice → loom.policy-deny-duplicate", async () => {
    const diags = await denyDiags(hierarchy({ policy: "deny on Invoice\ndeny on Invoice" }));
    expect(diags.map((d) => d.code)).toContain("loom.policy-deny-duplicate");
  });

  it("deny read + deny write on the same aggregate is NOT a duplicate (distinct access)", async () => {
    const diags = await denyDiags(hierarchy({ policy: "deny on Invoice\ndeny write on Invoice" }));
    expect(diags.map((d) => d.code)).not.toContain("loom.policy-deny-duplicate");
  });

  it("a deny shadowing an allow on the same target+access → loom.policy-deny-shadows-allow (warning)", async () => {
    const diags = await denyDiags(hierarchy({ policy: "allow deep on Invoice\ndeny on Invoice" }));
    const shadow = diags.find((d) => d.code === "loom.policy-deny-shadows-allow");
    expect(shadow).toBeDefined();
    expect(shadow!.severity).toBe("warning");
  });

  it("a deny WRITE does not shadow an allow READ (different access)", async () => {
    const diags = await denyDiags(
      hierarchy({ policy: "allow deep on Invoice\ndeny write on Invoice" }),
    );
    expect(diags.map((d) => d.code)).not.toContain("loom.policy-deny-shadows-allow");
  });

  it("a lone deny (no allow) is meaningful, not redundant — no diagnostic", async () => {
    expect(await denyDiags(hierarchy({ policy: "deny on Invoice" }))).toEqual([]);
  });
});
