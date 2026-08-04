// The two e2e verbs that used to point at nothing: `destroy` and `all`.
//
// `deriveAggregateOperations` (`src/ir/util/api-surface.ts`) routes two of an
// aggregate's operations SPECIALLY — the canonical destroy to
// `DELETE /api/<aggs>/{id}`, and the auto-`findAll` to the BARE collection root
// `GET /api/<aggs>` — and all five backends mount them there
// (`api-surface-parity.test.ts` reads both off each backend's own router).  The
// e2e renderer did neither:
//
//   • `api.<aggs>.destroy(id)` was rejected outright — the canonical destroy is
//     not in `agg.operations` (lowering keeps lifecycle actions in
//     `agg.destroys`), so it fell through to `loom.e2e-unknown-method`.
//   • `api.<aggs>.all()` rendered `GET /api/<aggs>/all`, a path no backend
//     registers, so the assertion 404'd instead of exercising the list route.
//
// So the delete and list routes of every generated system were untestable from
// the DSL — 98 of the caller census's pins (`test/ir/api-caller-census-pins.ts`)
// were that one gap, twice.  These tests pin the two arms against the
// DERIVATION rather than against a hand-written string, so a route move on
// either side fails here.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { BoundedContextIR } from "../../src/ir/types/loom-ir.js";
import { deriveContextOperations } from "../../src/ir/util/api-surface.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { generateSystemFiles } from "../_helpers/index.js";
import { parseString } from "../_helpers/parse.js";

const SYS = `
  system Shop {
    subdomain Sales {
      context Orders {
        aggregate Order with crudish {
          code: string
          status: string
        }
        repository Orders for Order {
          find byStatus(status: string): Order[] where this.status == status
        }
      }
    }
    api OrdersApi from Sales
    storage pg { type: postgres }
    resource s { for: Orders, kind: state, use: pg }
    deployable d {
      platform: node
      contexts: [Orders]
      dataSources: [s]
      serves: OrdersApi
      port: 4000
    }
    test e2e "list, delete, list again" against d {
      let a = api.orders.create({ code: "A", status: "Open" })
      api.orders.create({ code: "B", status: "Open" })
      let both = api.orders.all()
      expect(both.items.length).toBe(2)
      api.orders.destroy(a)
      expect(api.orders.getById(a)).toThrow(404)
      let left = api.orders.all()
      expect(left.items.length).toBe(1)
      let open = api.orders.byStatus({ status: "Open" })
      expect(open.length).toBe(1)
    }
  }
`;

const e2eOf = async (src: string): Promise<string> =>
  (await generateSystemFiles(src)).get("e2e/Shop.e2e.test.ts")!;

/** `(method, path)` of every api call the emitted suite makes, with template
 *  substitutions collapsed back to `{id}` so the pairs speak the derivation's
 *  vocabulary and can be compared to it directly. */
function emittedRoutes(e2e: string): Set<string> {
  const METHOD: Record<string, string> = {
    __post: "post",
    __get: "get",
    __getQuery: "get",
    __delete: "delete",
  };
  const out = new Set<string>();
  // `getQuery` BEFORE `get` — the alternation is ordered, and only a call site
  // is matched (the helper DEFINITIONS take `(url: string`, not a template).
  for (const m of e2e.matchAll(/(__post|__getQuery|__get|__delete)\(`([^`]*)`/g)) {
    const path = m[2]!.replace(/^\$\{base\}/, "").replace(/\$\{[^}]*\}/g, "{id}");
    out.add(`${METHOD[m[1]!]} ${path}`);
  }
  return out;
}

async function derivedRoutes(src: string): Promise<Set<string>> {
  const { model } = await parseString(src, { validate: false });
  const enriched = enrichLoomModel(lowerModel(model));
  const out = new Set<string>();
  for (const sys of enriched.systems) {
    for (const sd of sys.subdomains) {
      for (const ctx of sd.contexts) {
        for (const op of deriveContextOperations(ctx as BoundedContextIR)) {
          out.add(`${op.method} ${op.path}`);
        }
      }
    }
  }
  return out;
}

describe("e2e `destroy` — the canonical DELETE route", () => {
  it("renders DELETE /api/<aggs>/{id}, not POST /{id}/destroy", async () => {
    const e2e = await e2eOf(SYS);
    expect(e2e).toContain("await __delete(`${base}/api/orders/${a.id}`)");
    // The shape it used to be reachable-looking as, and which nothing mounts.
    expect(e2e).not.toContain("/destroy");
  });

  it("emits a `__delete` helper that pins the declared 204-empty success", async () => {
    const e2e = await e2eOf(SYS);
    expect(e2e).toContain("async function __delete(");
    expect(e2e).toContain('method: "DELETE"');
    // Not just `r.ok`: the declared contract is 204 with an empty body on all
    // five backends, and a 200-with-body would satisfy `r.ok` (the #2342 class).
    expect(e2e).toContain('if (r.status !== 204 || text !== "")');
  });

  it("emits `__delete` ONLY when a suite deletes", async () => {
    const withoutDelete = SYS.replace("      api.orders.destroy(a)\n", "");
    const e2e = await e2eOf(withoutDelete);
    expect(e2e).not.toContain("__delete");
  });

  it("the emitted DELETE is a route the derivation says is mounted", async () => {
    expect(await derivedRoutes(SYS)).toContain("delete /api/orders/{id}");
    expect(emittedRoutes(await e2eOf(SYS))).toContain("delete /api/orders/{id}");
  });

  it("an aggregate with only a NAMED destroy has no DELETE route, and no `destroy` verb", async () => {
    // `destroy archive { }` is not canonical: `deriveAggregateOperations` emits
    // no DELETE for it, so the e2e verb must keep failing rather than render a
    // route nothing serves.  Same predicate on both sides — `canonicalDestroy`.
    const named = `
      system Shop {
        subdomain Sales {
          context Orders {
            aggregate Order {
              code: string
              create(code: string) { this.code := code }
              destroy archive { }
            }
            repository Orders for Order { }
          }
        }
        storage pg { type: postgres }
        resource s { for: Orders, kind: state, use: pg }
        deployable d { platform: node contexts: [Orders] dataSources: [s] port: 4000 }
        test e2e "delete it" against d {
          let a = api.orders.create({ code: "A" })
          api.orders.destroy(a)
        }
      }
    `;
    expect([...(await derivedRoutes(named))].filter((r) => r.startsWith("delete "))).toEqual([]);
    const { model } = await parseString(named, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(
      diags.some(
        (d) => d.code === "loom.e2e-unknown-method" && d.message.includes("api.orders.destroy"),
      ),
    ).toBe(true);
  });

  it("validation accepts `destroy` on an aggregate that HAS a canonical destroy", async () => {
    const { model } = await parseString(SYS, { validate: false });
    const diags = validateLoomModel(enrichLoomModel(lowerModel(model)));
    expect(diags.filter((d) => d.code === "loom.e2e-unknown-method")).toEqual([]);
  });
});

describe("e2e `all` — the auto-findAll at the bare collection root", () => {
  it("renders GET /api/<aggs>, never GET /api/<aggs>/all", async () => {
    const e2e = await e2eOf(SYS);
    expect(e2e).toContain("await __getQuery(`${base}/api/orders`, {})");
    expect(e2e).not.toContain("/api/orders/all");
  });

  it("still renders a DECLARED find under its own path segment", async () => {
    const e2e = await e2eOf(SYS);
    expect(e2e).toContain('await __getQuery(`${base}/api/orders/by_status`, ({ status: "Open" }))');
  });

  it("passes an argument object through as the query string (page / pageSize / sort)", async () => {
    const paged = SYS.replace("api.orders.all()\n", "api.orders.all({ page: 1, pageSize: 25 })\n");
    const e2e = await e2eOf(paged);
    expect(e2e).toContain("await __getQuery(`${base}/api/orders`, ({ page: 1, pageSize: 25 }))");
  });

  it("the emitted root GET is a route the derivation says is mounted", async () => {
    expect(await derivedRoutes(SYS)).toContain("get /api/orders");
    expect(emittedRoutes(await e2eOf(SYS))).toContain("get /api/orders");
  });

  it("every route the suite calls is one the derivation mounts", async () => {
    // The whole point of both arms: no emitted call may address a path the
    // derivation (and therefore the backends) does not register.
    const derived = await derivedRoutes(SYS);
    const unmounted = [...emittedRoutes(await e2eOf(SYS))].filter((r) => !derived.has(r));
    expect(unmounted, `e2e calls that address no mounted route: ${unmounted.join(", ")}`).toEqual(
      [],
    );
  });
});
