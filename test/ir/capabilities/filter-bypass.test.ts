// `ignoring` filter-bypass clause (named-filter-bypass.md §11) — lowering +
// the three fail-fast IR validator gates.
//
// Lowering: the grammar `bypass`/`bypassAll` fields resolve onto FindIR /
// repo-run WorkflowStmtIR as `bypassCaps` (resolved capability names)
// / `bypassAll` (the `*` wildcard).
//
// Validator (validateFilterBypassSupport), over a full system with a deployable:
//   loom.filter-bypass-unsupported        — read served by an unsupported backend
//                                            (all DB backends — dotnet/node/elixir/
//                                            java/python — now honor it)
//   loom.filter-bypass-unknown-capability — ignoring an unimplemented capability
//   loom.filter-bypass-no-filter          — ignoring a stamps-only capability

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../../src/ir/lower/lower.js";
import type { FindIR } from "../../../src/ir/types/loom-ir.js";
import { validateLoomModel } from "../../../src/ir/validate/validate.js";
import { buildLoomModel } from "../../_helpers/ir.js";
import { parseString } from "../../_helpers/parse.js";

function findInModel(
  ir: { systems: { subdomains: { contexts: { repositories: { finds: FindIR[] }[] }[] }[] }[] },
  name: string,
): FindIR {
  for (const s of ir.systems)
    for (const m of s.subdomains)
      for (const c of m.contexts)
        for (const r of c.repositories) for (const f of r.finds) if (f.name === name) return f;
  throw new Error(`find ${name} not found`);
}

const LOWER_SRC = `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    subdomain D { context C {
      criterion BigOrders() of Order = this.total > 0
      aggregate Order with softDeletable { total: int }
      repository OrderRepo for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
        find allRows(): Order[] ignoring *
        find normal(): Order[] where this.total > 0
      }
      workflow Sweep {
        create(x: int) {
          let xs = OrderRepo.findAll(BigOrders()) ignoring softDeletable
          let ys = OrderRepo.findAll(BigOrders()) ignoring *
          for o in xs { }
          for o in ys { }
        }
      }
    }}
  }
`;

describe("ignoring filter-bypass lowering", () => {
  it("resolves capability names onto FindIR.bypassCaps and `*` to bypassAll", async () => {
    const ir = await buildLoomModel(LOWER_SRC);
    const recent = findInModel(ir, "recent");
    expect(recent.bypassCaps).toEqual(["softDeletable"]);
    expect(recent.bypassAll).toBeUndefined();

    const allRows = findInModel(ir, "allRows");
    expect(allRows.bypassAll).toBe(true);
    expect(allRows.bypassCaps).toBeUndefined();

    const normal = findInModel(ir, "normal");
    expect(normal.bypassAll).toBeUndefined();
    expect(normal.bypassCaps).toBeUndefined();
  });

  it("resolves inline repo-run bypass (named + `*`) in the workflow body", async () => {
    const ir = await buildLoomModel(LOWER_SRC);
    let named: string[] | undefined;
    let all = false;
    for (const s of ir.systems)
      for (const m of s.subdomains)
        for (const c of m.contexts)
          for (const wf of c.workflows)
            for (const create of wf.creates)
              for (const st of create.statements)
                if (st.kind === "repo-run") {
                  if (st.bypassCaps) named = st.bypassCaps;
                  if (st.bypassAll) all = true;
                }
    expect(named).toEqual(["softDeletable"]);
    expect(all).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validator gates — each over a full system with one deployable.
// ---------------------------------------------------------------------------

async function bypassDiags(source: string): Promise<{ code: string; message: string }[]> {
  const { model } = await parseString(source, { validate: false });
  return validateLoomModel(enrichLoomModel(lowerModel(model)))
    .filter((d) => d.severity === "error" && d.code?.startsWith("loom.filter-bypass"))
    .map((d) => ({ code: d.code!, message: d.message }));
}

const deployable = (platform: string) => `
  api A from D
  storage primary { type: postgres }
  resource st { for: C, kind: state, use: primary }
  deployable api { platform: ${platform}, contexts: [C], dataSources: [st], serves: A, port: 8081 }
`;

// elixir on the vanilla foundation (Slice-2-supported); contrast with the
// default `platform: elixir` (Ash foundation, still fail-fast).
const ELIXIR_VANILLA = "elixir";

const systemWith = (ctxBody: string, platform = "dotnet") => `
  system S {
    capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
    capability auditable { createdAt: datetime  stamp onCreate { createdAt := now() } }
    subdomain D { context C {
      aggregate Order with softDeletable, auditable { total: int }
      ${ctxBody}
    }}
    ${deployable(platform)}
  }
`;

describe("ignoring filter-bypass validator gates", () => {
  it("accepts a valid bypass on a dotnet deployable (no diagnostics)", async () => {
    const diags = await bypassDiags(
      systemWith(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring softDeletable
      }`),
    );
    expect(diags).toEqual([]);
  });

  it("accepts `ignoring *` on a dotnet deployable", async () => {
    const diags = await bypassDiags(
      systemWith(`repository R for Order {
        find allRows(): Order[] ignoring *
      }`),
    );
    expect(diags).toEqual([]);
  });

  it("accepts a valid bypass on a node deployable (Slice 2 — Drizzle omits the conjunct)", async () => {
    const diags = await bypassDiags(
      systemWith(
        `repository R for Order {
          find recent(): Order[] where this.total > 0 ignoring softDeletable
        }`,
        "node",
      ),
    );
    expect(diags).toEqual([]);
  });

  it("accepts a valid bypass on an elixir VANILLA deployable (Slice 2 — Ecto omits the where)", async () => {
    const diags = await bypassDiags(
      systemWith(
        `repository R for Order {
          find recent(): Order[] where this.total > 0 ignoring softDeletable
        }`,
        ELIXIR_VANILLA,
      ),
    );
    expect(diags).toEqual([]);
  });

  it("accepts a valid bypass on an elixir ASH deployable (Slice 3 — §11.6 base_filter→per-read triage)", async () => {
    const diags = await bypassDiags(
      systemWith(
        `repository R for Order {
          find recent(): Order[] where this.total > 0 ignoring softDeletable
        }`,
        "elixir",
      ),
    );
    expect(diags).toEqual([]);
  });

  it("accepts a valid bypass on a java deployable (§11.6 @SQLRestriction→bypassable @Filter triage)", async () => {
    const diags = await bypassDiags(
      systemWith(
        `repository R for Order {
          find recent(): Order[] where this.total > 0 ignoring softDeletable
        }`,
        "java",
      ),
    );
    expect(diags).toEqual([]);
  });

  it("accepts a valid bypass on a python deployable (SQLAlchemy omits the conjunct)", async () => {
    const diags = await bypassDiags(
      systemWith(
        `repository R for Order {
          find recent(): Order[] where this.total > 0 ignoring softDeletable
        }`,
        "python",
      ),
    );
    expect(diags).toEqual([]);
  });

  it("loom.filter-bypass-unknown-capability — capability not implemented", async () => {
    const diags = await bypassDiags(
      systemWith(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring tenantScoped
      }`),
    );
    expect(diags.map((d) => d.code)).toEqual(["loom.filter-bypass-unknown-capability"]);
  });

  it("loom.filter-bypass-no-filter — capability contributes no filter (stamps-only)", async () => {
    const diags = await bypassDiags(
      systemWith(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring auditable
      }`),
    );
    expect(diags.map((d) => d.code)).toEqual(["loom.filter-bypass-no-filter"]);
  });

  it("fires on an inline repo-run bypass of an unknown capability", async () => {
    const diags = await bypassDiags(
      systemWith(`repository R for Order {
        find recent(): Order[] where this.total > 0 ignoring tenantScoped
      }`),
    );
    expect(diags.map((d) => d.code)).toEqual(["loom.filter-bypass-unknown-capability"]);
  });
});

// ---------------------------------------------------------------------------
// Query-time projection `ignoring` — the projection twin of a repository
// `find … ignoring` (the synthesised source find carries the same bypass, so
// the three gates apply to a projection read identically).
// ---------------------------------------------------------------------------

/** The lowered query on the named projection. */
function projectionQueryInModel(
  ir: {
    systems: {
      subdomains: {
        contexts: {
          projections: { name: string; query?: { bypassAll?: boolean; bypassCaps?: string[] } }[];
        }[];
      }[];
    }[];
  },
  name: string,
): { bypassAll?: boolean; bypassCaps?: string[] } {
  for (const s of ir.systems)
    for (const m of s.subdomains)
      for (const c of m.contexts)
        for (const p of c.projections) if (p.name === name && p.query) return p.query;
  throw new Error(`projection query ${name} not found`);
}

describe("projection `ignoring` filter-bypass", () => {
  const PROJ_SRC = `
    system S {
      capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
      subdomain D { context C {
        aggregate Order with softDeletable { status: string }
        repository Orders for Order { }
        projection AllOrders { status: string  from Order as o ignoring softDeletable select status = o.status }
        projection PurgedOrders { status: string  from Order as o ignoring * select status = o.status }
        projection LiveOrders { status: string  from Order as o where o.status == "open" select status = o.status }
      }}
    }
  `;

  it("resolves `ignoring <Cap>` / `ignoring *` onto ProjectionQueryIR", async () => {
    const ir = await buildLoomModel(PROJ_SRC);
    const all = projectionQueryInModel(ir, "AllOrders");
    expect(all.bypassCaps).toEqual(["softDeletable"]);
    expect(all.bypassAll).toBeUndefined();

    const purged = projectionQueryInModel(ir, "PurgedOrders");
    expect(purged.bypassAll).toBe(true);
    expect(purged.bypassCaps).toBeUndefined();

    const live = projectionQueryInModel(ir, "LiveOrders");
    expect(live.bypassAll).toBeUndefined();
    expect(live.bypassCaps).toBeUndefined();
  });

  const projSystemWith = (projBody: string, platform = "node") => `
    system S {
      capability softDeletable { isDeleted: bool  filter this.isDeleted == false }
      capability auditable { createdAt: datetime  stamp onCreate { createdAt := now() } }
      subdomain D { context C {
        aggregate Order with softDeletable, auditable { status: string }
        repository Orders for Order { }
        ${projBody}
      }}
      ${deployable(platform)}
    }
  `;

  it("accepts a valid projection bypass on a node deployable", async () => {
    const diags = await bypassDiags(
      projSystemWith(
        `projection AllOrders { status: string  from Order as o ignoring softDeletable select status = o.status }`,
      ),
    );
    expect(diags).toEqual([]);
  });

  it("loom.filter-bypass-unknown-capability — projection ignores an unimplemented cap", async () => {
    const diags = await bypassDiags(
      projSystemWith(
        `projection P { status: string  from Order as o ignoring tenantScoped select status = o.status }`,
      ),
    );
    expect(diags.map((d) => d.code)).toEqual(["loom.filter-bypass-unknown-capability"]);
  });

  it("loom.filter-bypass-no-filter — projection ignores a stamps-only cap", async () => {
    const diags = await bypassDiags(
      projSystemWith(
        `projection P { status: string  from Order as o ignoring auditable select status = o.status }`,
      ),
    );
    expect(diags.map((d) => d.code)).toEqual(["loom.filter-bypass-no-filter"]);
  });
});
