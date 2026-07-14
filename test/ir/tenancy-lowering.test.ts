import { wireFieldsFor } from "../../src/ir/enrich/wire-projection.js";
// Tenancy IR lowering — slice 1a.1 of multi-tenancy Phase 1a
// (docs/old/plans/multi-tenancy-implementation.md).  `tenancy by user.<claim>
// of <Registry>` lowers to `SystemIR.tenancy: TenancyIR`; the
// `crossTenant` aggregate header flag lowers to `AggregateIR.crossTenant`.
// NO stance classification is stamped on the IR — that is derived on
// demand by the slice-1a.3 tenancy checks (derive-don't-stamp).

import { describe, expect, it } from "vitest";
import { schemaFromModule } from "../../src/system/migrations-builder.js";
import { buildLoomModel } from "../_helpers/ir.js";

const TENANCY_SOURCE = `
system Billder {
  user { id: guid  email: string  tenantId: string }
  tenancy by user.tenantId of Organization
  subdomain Billing {
    context Invoicing {
      aggregate Invoice with tenantOwned { number: string }
      aggregate Plan crossTenant { code: string }
      aggregate Organization { name: string }
      repository Invoices for Invoice { }
      repository Plans for Plan { }
      repository Organizations for Organization { }
    }
  }
  deployable api { platform: node, contexts: [Invoicing], port: 3000 }
}
`;

describe("tenancy by — SystemIR lowering", () => {
  it("carries the declaration as SystemIR.tenancy { claimField, registryName }", async () => {
    const ir = await buildLoomModel(TENANCY_SOURCE);
    expect(ir.systems[0]!.tenancy).toEqual({
      claimField: "tenantId",
      registryName: "Organization",
    });
  });

  it("stays undefined when the system declares no tenancy", async () => {
    const ir = await buildLoomModel(`
      system D { subdomain M { context C {
        aggregate Order { subject: string }
        repository Orders for Order { }
      }}}
    `);
    expect(ir.systems[0]!.tenancy).toBeUndefined();
  });
});

describe("crossTenant — AggregateIR lowering", () => {
  it("lowers the header flag onto the aggregate, mirrors isAbstract's omitted-≡-false shape", async () => {
    const ir = await buildLoomModel(TENANCY_SOURCE);
    const aggs = ir.systems[0]!.subdomains[0]!.contexts[0]!.aggregates;
    const byName = new Map(aggs.map((a) => [a.name, a]));
    expect(byName.get("Plan")!.crossTenant).toBe(true);
    // Unmarked aggregates carry no flag (omitted ≡ false, like isAbstract):
    expect(byName.get("Invoice")!.crossTenant).toBeUndefined();
    expect(byName.get("Organization")!.crossTenant).toBeUndefined();
  });
});

describe("tenantOwned — wire / migration sanity", () => {
  it("a `with tenantOwned` aggregate's wireShape carries tenantId and its table gains the tenant_id column", async () => {
    const ir = await buildLoomModel(TENANCY_SOURCE);
    const module = ir.systems[0]!.subdomains[0]!;
    const invoice = module.contexts[0]!.aggregates.find((a) => a.name === "Invoice")!;
    expect(wireFieldsFor(invoice).map((f) => f.name)).toContain("tenantId");
    // Capability fields flow into migrations automatically (phase ⑨):
    const invoices = schemaFromModule(module).tables.find((t) => t.name === "invoices")!;
    expect(invoices.columns.map((c) => c.name)).toContain("tenant_id");
    // crossTenant / unmarked aggregates get no tenant column:
    const plans = schemaFromModule(module).tables.find((t) => t.name === "plans")!;
    expect(plans.columns.map((c) => c.name)).not.toContain("tenant_id");
  });
});
