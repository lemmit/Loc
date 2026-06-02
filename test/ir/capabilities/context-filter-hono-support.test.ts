// Phase 2 deferral guard.  On the Hono/Drizzle backend, two capability-
// filter cases are not yet wired and would otherwise emit silently-wrong
// SQL, so the validator rejects them with loom.context-filter-unsupported:
//   1. principal-referencing filters (tenancy, `currentUser.*`);
//   2. non-relational shapes (shape(document) / shape(embedded)).
// A non-principal filter on a relational aggregate is accepted (and
// emitted — see context-filter-emit.test.ts).  On .NET, all are accepted
// (EF Core HasQueryFilter handles them).

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { parseString } from "../../_helpers/parse.js";

async function honoFilterErrors(source: string): Promise<string[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code === "loom.context-filter-unsupported")
    .map((d) => d.message);
}

function sys(platform: string, opts: { shape?: string; filter: string }): string {
  const shapeMod = opts.shape ? ` shape(${opts.shape})` : "";
  return `
system Shop {
  user { id: string  tenantId: string }
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid${shapeMod} {
        total: int
        tenantId: string
        isDeleted: bool
        ${opts.filter}
      }
    }
  }
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], port: 4000 }
}
`;
}

describe("hono capability-filter support guard", () => {
  it("accepts a non-principal relational filter on hono", async () => {
    expect(await honoFilterErrors(sys("hono", { filter: "filter !this.isDeleted" }))).toEqual([]);
  });

  it("rejects a principal-referencing filter on hono", async () => {
    const errs = await honoFilterErrors(
      sys("hono", { filter: "filter this.tenantId == currentUser.tenantId" }),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("currentUser");
  });

  it("rejects a capability filter on a non-relational (document) hono aggregate", async () => {
    const errs = await honoFilterErrors(
      sys("hono", { shape: "document", filter: "filter !this.isDeleted" }),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("shape(document)");
  });

  it("accepts both cases on a dotnet deployable (HasQueryFilter handles them)", async () => {
    expect(
      await honoFilterErrors(
        sys("dotnet", { filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
    expect(
      await honoFilterErrors(
        sys("dotnet", { shape: "document", filter: "filter !this.isDeleted" }),
      ),
    ).toEqual([]);
  });
});
