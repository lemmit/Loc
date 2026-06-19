// Capability-filter support guard.  Principal-referencing filters (tenancy,
// `currentUser.*`) on a RELATIONAL aggregate are now wired on the Hono/Drizzle
// backend (DEBT-01 — rendered against the ambient `requireCurrentUser()`
// accessor, the analogue of EF Core `HasQueryFilter`).  Still gated with
// loom.context-filter-unsupported:
//   1. non-relational shapes (shape(document) / shape(embedded)) — on node too;
//   2. principal-referencing filters on the elixir / java backends.
// A non-principal filter on a relational aggregate is accepted (and emitted —
// see context-filter-emit.test.ts).  On .NET, all are accepted.

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
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: ${platform}, contexts: [Shop], dataSources: [shopState], serves: ShopApi, auth: required, port: 4000 }
}
`;
}

describe("hono capability-filter support guard", () => {
  it("accepts a non-principal relational filter on hono", async () => {
    expect(await honoFilterErrors(sys("node", { filter: "filter !this.isDeleted" }))).toEqual([]);
  });

  it("accepts a principal-referencing (tenancy) filter on a relational hono aggregate (DEBT-01)", async () => {
    expect(
      await honoFilterErrors(
        sys("node", { filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("accepts a principal filter on elixir/Ash (DEBT-01 — base_filter ^actor)", async () => {
    expect(
      await honoFilterErrors(
        sys("elixir", { filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("accepts a principal filter on elixir-vanilla (DEBT-01 — threaded current_user + pinned predicate)", async () => {
    expect(
      await honoFilterErrors(
        sys("elixir { foundation: vanilla }", {
          filter: "filter this.tenantId == currentUser.tenantId",
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a principal filter on java (DEBT-01 — SpEL-principal JPQL clause)", async () => {
    expect(
      await honoFilterErrors(
        sys("java", { filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("requires 'auth: required' for a principal filter on hono (no principal to scope by otherwise)", async () => {
    const noAuth = `
system Shop {
  user { id: string  tenantId: string }
  subdomain Sales {
    context Shop {
      aggregate Cart ids guid { total: int  tenantId: string
        filter this.tenantId == currentUser.tenantId }
    }
  }
  api ShopApi from Sales
  storage pg { type: postgres }
  resource shopState { for: Shop, kind: state, use: pg }
  deployable api { platform: node, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}`;
    const errs = await honoFilterErrors(noAuth);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("auth: required");
  });

  it("still rejects a principal filter on a non-relational (document) hono aggregate", async () => {
    // Non-relational gates on node too — the principal-filter wiring is
    // relational-only.  Report the shape limitation.
    const errs = await honoFilterErrors(
      sys("node", { shape: "document", filter: "filter this.tenantId == currentUser.tenantId" }),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("shape(document)");
  });

  it("rejects a capability filter on a non-relational (document) hono aggregate", async () => {
    const errs = await honoFilterErrors(
      sys("node", { shape: "document", filter: "filter !this.isDeleted" }),
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
