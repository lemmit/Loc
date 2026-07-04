// Index-suggestion advisory lint (uniqueness-and-indexes.md §11, D-INDEX-SUGGEST).
// A query-filtered column with no covering leading-column index earns a
// warning-severity `loom.index-suggestion` naming the fix — never an
// auto-derived index. Covered columns (FK / tenant_id / unique-leading /
// manual-index-leading) and boolean columns are excluded.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { type LoomDiagnostic, validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

// The lint rides the normal `validateLoomModel` gate now (uniqueness-and-
// indexes.md §11); filter the advisory `loom.index-suggestion` code out of it.
function indexSuggestions(loom: Parameters<typeof validateLoomModel>[0]): LoomDiagnostic[] {
  return validateLoomModel(loom).filter((d) => d.code === "loom.index-suggestion");
}

async function suggestions(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return indexSuggestions(enrichLoomModel(lowerModel(model)));
}

const sys = (agg: string, repo: string, extra = "") => `
  system Shop {
    ${extra}
    subdomain Sales {
      context Ordering {
        ${agg}
        repository Customers for Customer { ${repo} }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    resource ordState { for: Ordering, kind: state, use: primarySql }
    deployable api { platform: node  contexts: [Ordering]  dataSources: [ordState]  serves: SalesApi  port: 3001 }
  }
`;

describe("loom.index-suggestion", () => {
  it("suggests an index for a finder-filtered scalar column with no index", async () => {
    const d = await suggestions(
      sys(
        `aggregate Customer with crudish { email: string  status: string }`,
        `find byStatus(status: string): Customer? where this.status == status`,
      ),
    );
    expect(d).toHaveLength(1);
    expect(d[0]!.severity).toBe("warning");
    expect(d[0]!.message).toContain("Customer.status");
    expect(d[0]!.message).toContain("index: Customer.status");
    expect(d[0]!.message).toContain("ordState"); // names the fix site
  });

  it("does NOT suggest a column covered by a `unique (...)` key", async () => {
    const d = await suggestions(
      sys(
        `aggregate Customer with crudish { email: string  unique (email) }`,
        `find byEmail(email: string): Customer? where this.email == email`,
      ),
    );
    expect(d).toEqual([]);
  });

  it("does NOT suggest a column covered by a manual `resource index:`", async () => {
    const { model } = await parseString(
      `
      system Shop {
        subdomain Sales {
          context Ordering {
            aggregate Customer with crudish { email: string  status: string }
            repository Customers for Customer {
              find byStatus(status: string): Customer? where this.status == status
            }
          }
        }
        api SalesApi from Sales
        storage primarySql { type: postgres }
        resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.status] }
        deployable api { platform: node  contexts: [Ordering]  dataSources: [ordState]  serves: SalesApi  port: 3001 }
      }`,
      { validate: false },
    );
    const d = indexSuggestions(enrichLoomModel(lowerModel(model)));
    expect(d).toEqual([]);
  });

  it("does NOT suggest a boolean column (poor standalone-index candidate)", async () => {
    const d = await suggestions(
      sys(
        `aggregate Customer with crudish { email: string  active: bool }`,
        `find byActive(active: bool): Customer? where this.active == active`,
      ),
    );
    expect(d).toEqual([]);
  });

  it("does NOT suggest an FK column (auto-indexed)", async () => {
    const d = await suggestions(
      sys(
        `aggregate Customer with crudish { email: string  owner: Owner id }
         aggregate Owner with crudish { name: string }`,
        `find byOwner(owner: Owner id): Customer? where this.owner == owner`,
      ),
    );
    expect(d.some((x) => x.message.includes("Customer.owner"))).toBe(false);
  });

  it("does NOT suggest tenant_id on a tenantOwned aggregate (derived index)", async () => {
    const d = await suggestions(`
      system Billder {
        user { id: guid  tenantId: string }
        tenancy by user.tenantId of Org
        subdomain Billing {
          context Accounts {
            aggregate Org with crudish { name: string }
            aggregate Invoice with crudish, tenantOwned { number: string }
            repository Invoices for Invoice {
              find byTenant(): Invoice? where this.tenantId == currentUser.tenantId
            }
          }
        }
        api BillingApi from Billing
        storage primarySql { type: postgres }
        resource acctState { for: Accounts, kind: state, use: primarySql }
        deployable api { platform: node  contexts: [Accounts]  dataSources: [acctState]  serves: BillingApi  port: 3001 }
      }`);
    expect(d.some((x) => x.message.includes("tenantId") || x.message.includes("tenant_id"))).toBe(
      false,
    );
  });

  it("suggests nothing when no finder filters an uncovered column", async () => {
    const d = await suggestions(sys(`aggregate Customer with crudish { email: string }`, ``));
    expect(d).toEqual([]);
  });
});
