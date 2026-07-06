// Capability-filter support guard.  Principal-referencing filters (tenancy,
// `currentUser.*`) on a RELATIONAL aggregate are wired on the Hono/Drizzle
// backend (DEBT-01 — rendered against the ambient `requireCurrentUser()`
// accessor, the analogue of EF Core `HasQueryFilter`).  Still gated with
// loom.context-filter-unsupported:
//   1. non-relational shapes (shape(document) / shape(embedded)) carrying a
//      principal filter on the elixir backend (handled below per case);
//   2. any capability filter (principal or not) on a non-relational shape on
//      python (no in-app filtering path there yet).
// Principal filters on an EMBEDDED shape ship on node/elixir/java (DEBT-02
// Slice A — embedded root scalars are real columns, so they reuse the relational
// principal path).  Principal filters on a DOCUMENT shape now ship on
// node/java/.NET too (DEBT-02 Slice B — the in-app document read binds the
// ambient principal fail-closed and AND-s the predicate over the rehydrated
// aggregate).  A non-principal filter on a relational aggregate is accepted
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
        sys("elixir", {
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

  // B16: .NET was exempt from the principal-filter-needs-auth gate (excluded
  // from LIMITED_FAMILIES), yet its EF `HasQueryFilter` renders
  // `RequestContext.Current!.CurrentUser!.<claim>` → NRE on every read when the
  // deployable has no auth.  The gate must reach .NET too.
  it("requires 'auth: required' for a principal filter on dotnet (finding 20 / B16)", async () => {
    const errs = await honoFilterErrors(
      sys("dotnet", { filter: "filter this.tenantId == currentUser.tenantId" }).replace(
        ", auth: required",
        "",
      ),
    );
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("dotnet");
    expect(errs[0]).toContain("auth: required");
  });

  it("accepts a principal filter on dotnet WITH auth (EF HasQueryFilter is fully wired)", async () => {
    expect(
      await honoFilterErrors(
        sys("dotnet", { filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("accepts a principal filter on a non-relational (document) hono aggregate (DEBT-02 Slice B — in-app actor eval)", async () => {
    // The document read binds the ambient principal fail-closed
    // (`const currentUser = requireCurrentUser();`) and AND-s the principal
    // predicate over the rehydrated aggregate.
    expect(
      await honoFilterErrors(
        sys("node", { shape: "document", filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
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

  it("accepts a PRINCIPAL filter on a node DOCUMENT aggregate (DEBT-02 Slice B — requireCurrentUser() in-app eval)", async () => {
    expect(
      await honoFilterErrors(
        sys("node", { shape: "document", filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("accepts a PRINCIPAL filter on a java DOCUMENT aggregate (DEBT-02 Slice B — CurrentUserAccessor in-app eval)", async () => {
    expect(
      await honoFilterErrors(
        sys("java", { shape: "document", filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
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
  // context-filter-emit.test.ts).  DEBT-02 then wired the PRINCIPAL
  // (`currentUser.*`) RELATIONAL case: the predicate renders
  // `require_current_user().<claim>` against the ambient ContextVar accessor
  // and AND-s into every root read (no read-method parameter — the SQLAlchemy
  // analogue of node's `requireCurrentUser()` weave).  DEBT-02 tail then wired
  // the `shape(embedded)` case (both non-principal and principal): an embedded
  // aggregate's root scalars are real columns, so `contextFilterPredicate` AND-s
  // into the embedded SQL reads exactly like the relational path.  DEBT-02 tail
  // is now COMPLETE: `shape(document)` is wired too — the blob is one JSONB
  // column, so the predicate is evaluated IN-APP over the rehydrated instance
  // (`documentCapabilityBody` → a list-comprehension filter), mirroring node.  A
  // principal filter still requires `auth: required` (no principal otherwise).

  it("accepts a NON-PRINCIPAL relational filter (W1a — now emitted)", async () => {
    // `sys("python", …)` declares `auth: required`, but a non-principal filter
    // doesn't need a principal to scope by, so that's immaterial here.
    expect(await honoFilterErrors(sys("python", { filter: "filter !this.isDeleted" }))).toEqual([]);
  });

  it("accepts a PRINCIPAL/tenancy filter on a relational python aggregate (DEBT-02)", async () => {
    expect(
      await honoFilterErrors(
        sys("python", { filter: "filter this.tenantId == currentUser.tenantId" }),
      ),
    ).toEqual([]);
  });

  it("requires 'auth: required' for a principal filter on python (no principal to scope by otherwise)", async () => {
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
  deployable api { platform: python, contexts: [Shop], dataSources: [shopState], serves: ShopApi, port: 4000 }
}`;
    const errs = await honoFilterErrors(noAuth);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("auth: required");
  });

  it("accepts a NON-PRINCIPAL filter on a python embedded aggregate (DEBT-02 tail)", async () => {
    expect(
      await honoFilterErrors(
        sys("python", { shape: "embedded", filter: "filter !this.isDeleted" }),
      ),
    ).toEqual([]);
  });

  it("accepts a PRINCIPAL filter on a python embedded aggregate (DEBT-02 tail — require_current_user() SQL where)", async () => {
    expect(
      await honoFilterErrors(
        sys("python", {
          shape: "embedded",
          filter: "filter this.tenantId == currentUser.tenantId",
        }),
      ),
    ).toEqual([]);
  });

  it("accepts a NON-PRINCIPAL filter on a python document aggregate (DEBT-02 tail complete — in-app filter)", async () => {
    // The jsonb blob isn't per-field queryable, so the predicate is evaluated
    // IN-APP over the rehydrated instance (`documentCapabilityBody` →
    // list-comprehension filter), mirroring node.
    expect(
      await honoFilterErrors(
        sys("python", { shape: "document", filter: "filter !this.isDeleted" }),
      ),
    ).toEqual([]);
  });

  it("accepts a PRINCIPAL filter on a python document aggregate (DEBT-02 tail complete)", async () => {
    expect(
      await honoFilterErrors(
        sys("python", {
          shape: "document",
          filter: "filter this.tenantId == currentUser.tenantId",
        }),
      ),
    ).toEqual([]);
  });
});
