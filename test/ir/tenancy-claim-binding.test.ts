// Tenancy claim binding — the principal side of the `tenantOwned` capability
// (M-T3.7(a)).
//
// `tenancy by user.<claim> of <Registry>` lets the author name the claim that
// carries the tenant.  The `tenantOwned` prelude capability cannot read that
// declaration — it is built once at language-module init with no system in
// scope — so it hardcodes `currentUser.tenantId` in both its read filter and
// its create stamp.  Enrichment (phase ⑥) binds it to the declared claim, the
// same way it already derives the registry self-scope.
//
// Before this pass the two halves of the feature disagreed in one generated
// project: the registry read `currentUser.orgId` while the tenant-owned
// aggregate read `currentUser.tenantId` — a claim the emitted principal type
// does not have.  Typed backends failed to compile; dynamic ones 500'd per
// request.
//
// The ROW column stays `tenantId` throughout: the capability owns that name,
// and it is not the author's to choose.  Only the principal side moves.

import { describe, expect, it } from "vitest";
import type { AggregateIR, ExprIR, LoomModel } from "../../src/ir/types/loom-ir.js";
import { TENANT_OWNED_CAPABILITY } from "../../src/ir/util/tenant-stance.js";
import { buildLoomModel } from "../_helpers/ir.js";

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

/** The `tenantOwned`-origin read filter — the flat tenant floor. */
function floorFilter(agg: AggregateIR): ExprIR {
  const origins = agg.contextFilterOrigins ?? [];
  const i = origins.indexOf(TENANT_OWNED_CAPABILITY);
  expect(i).toBeGreaterThanOrEqual(0);
  return agg.contextFilters![i]!;
}

/** The create stamp assigning the capability's `tenantId` column. */
function tenantStampValue(agg: AggregateIR): ExprIR {
  for (const s of agg.contextStamps ?? []) {
    for (const a of s.assignments) if (a.field === "tenantId") return a.value;
  }
  throw new Error(`no tenantId stamp on ${agg.name}`);
}

const src = (claim: string) => `
  system Billder {
    user { id: guid  ${claim}: string }
    tenancy by user.${claim} of Organization
    subdomain Billing {
      context Invoicing {
        aggregate Invoice with tenantOwned { number: string }
        repository Invoices for Invoice { }
      }
      context Accounts {
        aggregate Organization { name: string }
        repository Organizations for Organization { }
      }
    }
  }
`;

describe("tenancy claim binding — tenantOwned principal side", () => {
  it("binds the read filter's RHS to the declared claim, keeping the row column", async () => {
    const inv = findAgg(await buildLoomModel(src("orgId")), "Invoice");
    expect(floorFilter(inv)).toMatchObject({
      kind: "binary",
      op: "==",
      // LHS — the capability's ROW column, unchanged.
      left: { kind: "member", receiver: { kind: "this" }, member: "tenantId" },
      // RHS — the DECLARED claim, not the capability's hardcoded name.
      right: {
        kind: "member",
        receiver: { kind: "ref", name: "currentUser", refKind: "current-user" },
        member: "orgId",
      },
    });
  });

  it("binds the create stamp's source claim, keeping the stamped column", async () => {
    const inv = findAgg(await buildLoomModel(src("orgId")), "Invoice");
    expect(tenantStampValue(inv)).toMatchObject({
      kind: "member",
      receiver: { kind: "ref", name: "currentUser", refKind: "current-user" },
      member: "orgId",
    });
  });

  it("agrees with the registry self-scope — both halves read ONE claim", async () => {
    // The regression this closes: these two were derived independently, and
    // only the registry half honoured the declaration.
    const ir = await buildLoomModel(src("orgId"));
    const registryClaim = findAgg(ir, "Organization").contextFilters![0]!;
    expect(registryClaim).toMatchObject({ right: { member: "orgId" } });
    expect(floorFilter(findAgg(ir, "Invoice"))).toMatchObject({ right: { member: "orgId" } });
  });

  it("is a no-op when the claim IS `tenantId` (byte-neutral for every prior model)", async () => {
    const inv = findAgg(await buildLoomModel(src("tenantId")), "Invoice");
    expect(floorFilter(inv)).toMatchObject({
      left: { member: "tenantId" },
      right: { member: "tenantId" },
    });
    expect(tenantStampValue(inv)).toMatchObject({ member: "tenantId" });
  });

  it("leaves an AUTHOR's own `currentUser.tenantId` alone", async () => {
    // Under a system whose tenancy claim is `orgId`, a principal may still
    // legitimately carry an unrelated `tenantId` field.  The pass rebinds only
    // capability-derived nodes, so a hand-written filter keeps its own name —
    // otherwise the fix would silently rewrite author intent.
    const ir = await buildLoomModel(`
      system Billder {
        user { id: guid  orgId: string  tenantId: string }
        tenancy by user.orgId of Organization
        subdomain Billing {
          context Invoicing {
            aggregate Invoice with tenantOwned {
              number: string
              legacyTenant: string
              filter this.legacyTenant == currentUser.tenantId
            }
            repository Invoices for Invoice { }
          }
          context Accounts {
            aggregate Organization { name: string }
            repository Organizations for Organization { }
          }
        }
      }
    `);
    const inv = findAgg(ir, "Invoice");
    // The capability filter moved to `orgId` …
    expect(floorFilter(inv)).toMatchObject({ right: { member: "orgId" } });
    // … while the author's own filter still reads `tenantId`.
    const authored = (inv.contextFilters ?? []).find(
      (f) => f.kind === "binary" && f.left.kind === "member" && f.left.member === "legacyTenant",
    );
    expect(authored).toMatchObject({ right: { member: "tenantId" } });
  });
});
