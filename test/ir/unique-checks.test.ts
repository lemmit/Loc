// IR-level `unique (...)` checks (uniqueness-and-indexes.md §5, §8) — the two
// rules that need the merged, type-resolved IR:
//   - loom.unique-valueobject-field    — a value-object column has no single
//                                         physical column to constrain (error)
//   - loom.unique-missing-tenant-scope  — a tenant-owned aggregate's key omits
//                                         the tenant discriminator (warning)

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { parseString } from "../_helpers/parse.js";

async function uniqueDiags(source: string): Promise<LoomDiagnostic[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model))).filter((d) =>
    (d.code ?? "").startsWith("loom.unique-"),
  );
}

describe("loom.unique-valueobject-field", () => {
  it("rejects a value-object column (no single physical column)", async () => {
    const diags = await uniqueDiags(`
      system Shop {
        subdomain Sales {
          context Ordering {
            valueobject Money { amount: decimal  currency: string }
            aggregate Product {
              sku: string
              price: Money
              unique (price)
            }
            repository Products for Product { }
          }
        }
      }
    `);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ severity: "error", code: "loom.unique-valueobject-field" });
    expect(diags[0]!.message).toContain("'price'");
  });

  it("accepts a scalar column key (no diagnostics)", async () => {
    const diags = await uniqueDiags(`
      system Shop {
        subdomain Sales {
          context Ordering {
            aggregate Product {
              sku: string
              unique (sku)
            }
            repository Products for Product { }
          }
        }
      }
    `);
    expect(diags).toEqual([]);
  });
});

describe("loom.unique-missing-tenant-scope", () => {
  const sys = (agg: string) => `
    system Billder {
      user { id: guid  tenantId: string }
      tenancy by user.tenantId of Organization
      subdomain Billing {
        context Accounts {
          aggregate Organization { name: string }
          ${agg}
          repository Invoices for Invoice { }
        }
      }
    }
  `;

  it("warns when a tenant-owned key omits the tenant discriminator", async () => {
    const diags = await uniqueDiags(
      sys(`aggregate Invoice with tenantOwned { number: string  unique (number) }`),
    );
    const warn = diags.find((d) => d.code === "loom.unique-missing-tenant-scope");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");
    expect(warn!.message).toContain("unique (tenantId, number)");
  });

  it("does not warn when the tenant discriminator is in the key", async () => {
    const diags = await uniqueDiags(
      sys(`aggregate Invoice with tenantOwned { number: string  unique (tenantId, number) }`),
    );
    expect(diags.find((d) => d.code === "loom.unique-missing-tenant-scope")).toBeUndefined();
  });
});
