// `policy { allow write <level> on <Aggregate> }` — the WRITE ladder
// (authorization Phase 3 P3.1, docs/plans/authorization-phase3.md).  Covers
// parsing (the optional `verb`), lowering (`BoundedContextIR.policyWriteLevels`),
// the enrichment derivation of `AggregateIR.writeScopeFilter` (set only when the
// write scope is strictly narrower than the read scope), and the phase-⑦
// validator gates (the two new codes + coherence).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { deepScopeAnchorClaim, isDeepScopeFilter } from "../../src/ir/util/tenant-stance.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { buildLoomModel } from "../_helpers/ir.js";
import { parseString } from "../_helpers/parse.js";

const system = (opts: { policy: string }): string => `
  system Shop {
    user { id: guid  tenantId: string }
    tenancy by user.tenantId of Org
    subdomain S {
      context C {
        aggregate Invoice with tenantOwned {
          amount: int
          operation bump(by: int) { amount := amount + by }
        }
        aggregate Org {
          name: string
          implements tenantRegistry
        }
        repository Invoices for Invoice { }
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
  "loom.policy-write-global-unsupported",
  "loom.policy-write-wider-than-read",
]);

async function policyDiags(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).filter(
    (d) => d.code !== undefined && POLICY_CODES.has(d.code),
  );
}

function invoice(model: Awaited<ReturnType<typeof buildLoomModel>>) {
  const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
  return ctx.aggregates.find((a) => a.name === "Invoice")!;
}

describe("policy write levels — parsing + lowering", () => {
  it("lowers `allow write <level> on <Agg>` onto policyWriteLevels (read rules unaffected)", async () => {
    const model = await buildLoomModel(
      system({ policy: "allow deep on Invoice\nallow write local on Invoice" }),
    );
    const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
    expect(ctx.policyReadLevels).toEqual([
      { aggregate: "Invoice", level: "deep", source: "allow deep on Invoice" },
    ]);
    expect(ctx.policyWriteLevels).toEqual([
      { aggregate: "Invoice", level: "local", source: "allow write local on Invoice" },
    ]);
  });

  it("bare `allow` lowers to a READ rule (no write verb)", async () => {
    const model = await buildLoomModel(system({ policy: "allow deep on Invoice" }));
    const ctx = model.systems[0]!.subdomains[0]!.contexts[0]!;
    expect(ctx.policyReadLevels).toEqual([
      { aggregate: "Invoice", level: "deep", source: "allow deep on Invoice" },
    ]);
    expect(ctx.policyWriteLevels).toBeUndefined();
  });

  it("a context with no write rule carries no policyWriteLevels", async () => {
    const model = await buildLoomModel(system({ policy: "allow deep on Invoice" }));
    expect(model.systems[0]!.subdomains[0]!.contexts[0]!.policyWriteLevels).toBeUndefined();
  });
});

describe("policy write levels — enrichment (writeScopeFilter)", () => {
  it("write `local` under a `deep` read narrows the command load to the tenant FLOOR", async () => {
    const model = await buildLoomModel(
      system({ policy: "allow deep on Invoice\nallow write local on Invoice" }),
    );
    const wsf = invoice(model).writeScopeFilter;
    expect(wsf).toBeDefined();
    // The floor is the `this.tenantId == currentUser.tenantId` binary, NOT the
    // deep sentinel.
    expect(wsf!.kind).toBe("binary");
    expect(isDeepScopeFilter(wsf!)).toBe(false);
  });

  it("write `deep` under a `global` read narrows the command load to the `orgPath` subtree", async () => {
    const model = await buildLoomModel(
      system({ policy: "allow global on Invoice\nallow write deep on Invoice" }),
    );
    const wsf = invoice(model).writeScopeFilter;
    expect(wsf).toBeDefined();
    expect(isDeepScopeFilter(wsf!)).toBe(true);
    expect(deepScopeAnchorClaim(wsf!)).toBe("orgPath");
  });

  it("write scope == read scope leaves NO writeScopeFilter (byte-identical seam)", async () => {
    // deep read + deep write → same scope → no narrowing.
    const deep = await buildLoomModel(
      system({ policy: "allow deep on Invoice\nallow write deep on Invoice" }),
    );
    expect(invoice(deep).writeScopeFilter).toBeUndefined();
    // No policy at all → no narrowing.
    const none = await buildLoomModel(system({ policy: "allow deep on Invoice" }));
    // read deep + implicit write local IS a narrowing (floor < deep):
    expect(invoice(none).writeScopeFilter).toBeDefined();
    expect(invoice(none).writeScopeFilter!.kind).toBe("binary");
  });

  it("read `local` (no widening) leaves NO writeScopeFilter", async () => {
    const model = await buildLoomModel(system({ policy: "allow write local on Invoice" }));
    expect(invoice(model).writeScopeFilter).toBeUndefined();
  });
});

describe("policy write levels — validator gates", () => {
  it("accepts a coherent `allow write deep` (matching `allow deep` read)", async () => {
    const diags = await policyDiags(
      system({ policy: "allow deep on Invoice\nallow write deep on Invoice" }),
    );
    expect(diags).toEqual([]);
  });

  it("rejects `write global` — loom.policy-write-global-unsupported", async () => {
    const diags = await policyDiags(
      system({ policy: "allow global on Invoice\nallow write global on Invoice" }),
    );
    expect(diags.map((d) => d.code)).toContain("loom.policy-write-global-unsupported");
  });

  it("rejects `write deep` without a matching `deep`/`global` read — loom.policy-write-wider-than-read", async () => {
    const diags = await policyDiags(
      system({ policy: "allow local on Invoice\nallow write deep on Invoice" }),
    );
    expect(diags.map((d) => d.code)).toContain("loom.policy-write-wider-than-read");
  });

  it("rejects `write deep` with NO read rule (read defaults to local) — wider-than-read", async () => {
    const diags = await policyDiags(system({ policy: "allow write deep on Invoice" }));
    // deep write needs the hierarchy (present) but read is local → wider-than-read.
    expect(diags.map((d) => d.code)).toContain("loom.policy-write-wider-than-read");
  });

  it("rejects `write <level>` on an unknown / non-tenant-owned aggregate", async () => {
    const unknown = await policyDiags(system({ policy: "allow write local on Ghost" }));
    expect(unknown.map((d) => d.code)).toContain("loom.policy-unknown-aggregate");
  });
});
