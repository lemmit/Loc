// Capability-filter support guard.  Principal-referencing filters (tenancy,
// `currentUser.*`) on a RELATIONAL aggregate are now wired on the Hono/Drizzle
// backend (DEBT-01 — rendered against the ambient `requireCurrentUser()`
// accessor, the analogue of EF Core `HasQueryFilter`).  Still gated with
// loom.context-filter-unsupported:
//   1. non-relational shapes (shape(document) / shape(embedded)) — on node too;
//   2. principal-referencing filters on the elixir / java backends.
//   2b. principal-referencing filters on a DOCUMENT shape (in-app actor eval) —
//       still gated everywhere but .NET (DEBT-02 Slice B).
// Principal filters on an EMBEDDED shape now ship on node/elixir/java (DEBT-02
// Slice A — embedded root scalars are real columns, so they reuse the relational
// principal path).  A non-principal filter on a relational aggregate is accepted
// (and emitted — see context-filter-emit.test.ts).  On .NET, all are accepted.

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

  it("accepts a non-principal capability filter on a node DOCUMENT aggregate (DEBT-02 — in-app)", async () => {
    expect(
      await honoFilterErrors(sys("node", { shape: "document", filter: "filter !this.isDeleted" })),
    ).toEqual([]);
  });

  it("accepts a non-principal capability filter on a node EMBEDDED aggregate (DEBT-02 — SQL where)", async () => {
    expect(
      await honoFilterErrors(sys("node", { shape: "embedded", filter: "filter !this.isDeleted" })),
    ).toEqual([]);
  });

  it("accepts a non-principal capability filter on a java DOCUMENT aggregate (DEBT-02 — in-app)", async () => {
    expect(
      await honoFilterErrors(sys("java", { shape: "document", filter: "filter !this.isDeleted" })),
    ).toEqual([]);
  });

  it("accepts a non-principal capability filter on an elixir EMBEDDED aggregate (DEBT-02 — Ash base_filter)", async () => {
    expect(
      await honoFilterErrors(
        sys("elixir", { shape: "embedded", filter: "filter !this.isDeleted" }),
      ),
    ).toEqual([]);
  });

  it("accepts a PRINCIPAL filter on an elixir embedded aggregate (DEBT-02 — base_filter ^actor)", async () => {
    expect(
      await honoFilterErrors(
        sys("elixir", {
          shape: "embedded",
          filter: "filter this.tenantId == currentUser.tenantId",
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a PRINCIPAL filter on a node embedded aggregate (DEBT-02 — requireCurrentUser() SQL where)", async () => {
    expect(
      await honoFilterErrors(
        sys("node", { shape: "embedded", filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("accepts a PRINCIPAL filter on a java embedded aggregate (DEBT-02 — SpEL @Query overrides)", async () => {
    expect(
      await honoFilterErrors(
        sys("java", { shape: "embedded", filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("still gates a PRINCIPAL filter on a node DOCUMENT aggregate (in-app actor eval — DEBT-02 Slice B)", async () => {
    const errs = await honoFilterErrors(
      sys("node", { shape: "document", filter: "filter this.tenantId == currentUser.tenantId" }),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("shape(document)");
  });

  it("accepts a non-principal capability filter on a java EMBEDDED aggregate (DEBT-02 — @SQLRestriction)", async () => {
    expect(
      await honoFilterErrors(sys("java", { shape: "embedded", filter: "filter !this.isDeleted" })),
    ).toEqual([]);
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

describe("python capability-filter support guard (W1a)", () => {
  // W1a wired the NON-PRINCIPAL relational case on python (the WHERE predicate
  // AND-ed into every root read via `contextFilterPredicate` — see
  // context-filter-emit.test.ts).  python stays in LIMITED_FAMILIES, so the
  // remaining cases stay gated: a PRINCIPAL (`currentUser.*`) filter
  // (supportsPrincipalFilter false for python) and a NON-RELATIONAL shape
  // (supportsNonRelationalFilter false for python) both still error.

  it("accepts a NON-PRINCIPAL relational filter (W1a — now emitted)", async () => {
    // `sys("python", …)` declares `auth: required`, but a non-principal filter
    // doesn't need a principal to scope by, so that's immaterial here.
    expect(await honoFilterErrors(sys("python", { filter: "filter !this.isDeleted" }))).toEqual([]);
  });

  it("still gates a PRINCIPAL/tenancy filter (W1b — not yet wired on python)", async () => {
    const errs = await honoFilterErrors(
      sys("python", { filter: "filter this.tenantId == currentUser.tenantId" }),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("python");
    expect(errs[0]).toContain("references currentUser");
    expect(errs[0]).toContain("principal-referencing capability");
  });

  it("still gates a non-relational (document) shape filter", async () => {
    const errs = await honoFilterErrors(
      sys("python", { shape: "document", filter: "filter !this.isDeleted" }),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("python");
    expect(errs[0]).toContain("shape(document)");
  });
});
