// Render fidelity: the Phoenix router AND its OpenAPI spec render EXACTLY the
// derived surface — minus this backend's two DOCUMENTED local stances.
//
// The elixir sibling of `test/generator/dotnet/api-surface-render.test.ts`
// (see its header for the framing).  Elixir is the backend whose router and
// spec are SEPARATE emitters and have disagreed three times (PATCH-vs-POST
// update, the declared-but-unmounted `can_<op>`, the ES-refused DELETE the
// spec still documented) — so this suite's core assertion is three-way:
// derived set ≡ mounted set ≡ documented set.
//
// The two elixir-local stances (`servedOperationEntries` in api-emit.ts):
// a CRUD-verb-named op other than `update` is neither mounted nor documented
// (its action atom would collide with the Phoenix REST actions), and an
// event-sourced aggregate serves no generic `update`.  The stance test below
// pins that BOTH halves apply them — the spec advertising what the router
// refuses is exactly the bug class this backend kept re-shipping.

import { describe, expect, it } from "vitest";
import type { BoundedContextIR, LoomModel } from "../../../src/ir/types/loom-ir.js";
import { deriveContextOperations } from "../../../src/ir/util/api-surface.js";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { buildLoomModel } from "../../_helpers/ir.js";

/** Same surface as the python fidelity fixture — crudish (update), a
 *  when-gated op (+probe), a gated optional find, an error-payload absence
 *  union find — PLUS an `api` block, without which the spec module is not
 *  emitted at all (this backend's spec is gated on `serves`). */
const SOURCE = `
system P {
  subdomain D {
    context Orders {
      error Missing { resource: string }
      aggregate Order with crudish {
        code: string
        status: string
        operation cancel() when status == "Open" { status := "Cancelled" }
      }
      repository Orders for Order {
        find byCode(code: string): Order option requires currentUser.role == "admin"
        find byRef(ref: string): Order or Missing
      }
    }
  }
  api SalesApi from D { }
  user { id: string  role: string }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d {
    platform: elixir
    contexts: [Orders]
    dataSources: [st]
    serves: SalesApi
    port: 3000
    auth: required
  }
}
`;

interface Route {
  readonly method: string;
  readonly path: string;
}
const key = (r: Route): string => `${r.method.toLowerCase()} ${r.path}`;

/** Phoenix spells a path param `:id`; the derivation `{id}`. */
function normalisePath(p: string): string {
  const withBraces = p.replace(/:(\w+)/g, "{$1}");
  const trimmed = withBraces.replace(/\/+$/, "");
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** `<m> "<path>", Controller, :action` inside `scope "/api"`. */
function scrapeRouter(files: Map<string, string>): Route[] {
  const src = [...files].find(([p]) => p.endsWith("router.ex"))?.[1] ?? "";
  const scope = src.match(/scope "\/api",[\s\S]*?\n {2}end/)?.[0] ?? "";
  const out: Route[] = [];
  for (const m of scope.matchAll(/^\s*(get|post|put|patch|delete) "([^"]*)"/gm)) {
    out.push({ method: m[1]!, path: normalisePath(`/api${m[2]}`) });
  }
  return out;
}

/** The OpenApiSpex module's PathItems: `"<path>" => %OpenApiSpex.PathItem{`
 *  with the per-method `<m>: %OpenApiSpex.Operation{` entries and each
 *  operation's declared 4xx/5xx statuses (`<nnn> => %OpenApiSpex.Response`
 *  entries up to the operation's closing brace). */
function scrapeSpec(files: Map<string, string>): Map<string, number[]> {
  const src = [...files].find(([p]) => p.endsWith("_api_spec.ex"))?.[1] ?? "";
  const out = new Map<string, number[]>();
  // Split on PathItem boundaries; the spec serves under `url: "/api"`.
  const items = src.split(/"((?:\/[^"]+))" => %OpenApiSpex\.PathItem\{/).slice(1);
  for (let i = 0; i < items.length; i += 2) {
    const rel = items[i]!;
    const body = items[i + 1]!;
    for (const m of body.matchAll(
      /(get|post|put|patch|delete): %OpenApiSpex\.Operation\{([\s\S]*?)\n {8}\}/g,
    )) {
      const statuses = [...m[2]!.matchAll(/(\d{3}) => %OpenApiSpex\.Response\{/g)]
        .map((c) => Number(c[1]))
        .filter((c) => c >= 400)
        .sort((a, b) => a - b);
      out.set(key({ method: m[1]!, path: normalisePath(`/api${rel}`) }), statuses);
    }
  }
  return out;
}

function ordersContext(model: LoomModel): BoundedContextIR {
  const ctx = model.systems
    .flatMap((s) => s.subdomains)
    .flatMap((sd) => sd.contexts)
    .find((c) => c.name === "Orders");
  expect(ctx, "Orders context lowered").toBeDefined();
  return ctx!;
}

describe("elixir render fidelity — router and spec render exactly the derived surface", () => {
  it("mounts exactly the derived method+path set", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model))
      .map((o) => key({ method: o.method, path: o.path }))
      .sort();
    const files = await generateSystemFiles(SOURCE);
    const mounted = scrapeRouter(files)
      .map(key)
      .filter((k) => !k.endsWith("/openapi.json"))
      .sort();
    expect(mounted.length, "scraped no routes — the scraper is stale").toBeGreaterThan(0);
    // No CRUD-verb-named op and no ES aggregate in this fixture, so the two
    // elixir-local stances are inert and the sets are EXACTLY equal.
    expect(mounted).toEqual(derived);
  });

  it("documents exactly the mounted aggregate surface, with exactly op.errorStatuses", async () => {
    const model = await buildLoomModel(SOURCE);
    const derived = deriveContextOperations(ordersContext(model));
    const documented = scrapeSpec(await generateSystemFiles(SOURCE));
    expect(documented.size, "scraped no spec operations — the scraper is stale").toBeGreaterThan(0);
    for (const op of derived) {
      const k = key({ method: op.method, path: op.path });
      expect(documented.get(k), k).toEqual([...op.errorStatuses]);
    }
    // Three-way closure: nothing documented beyond the derived set either
    // (workflow routes would be, but this fixture declares none).
    expect([...documented.keys()].sort()).toEqual(
      derived.map((o) => key({ method: o.method, path: o.path })).sort(),
    );
  });

  it("a CRUD-verb-named op is neither mounted nor documented (the shared local stance)", async () => {
    // `operation list()` — a public op whose action atom would collide with
    // the Phoenix REST `:list`/`:index` family.  The router has always
    // excluded it; the SPEC used to advertise it anyway (a phantom route).
    // `servedOperationEntries` now drives both halves.
    const src = `
system P {
  subdomain D {
    context Orders {
      aggregate Order with crudish {
        code: string
        status: string
        operation list() { status := "listed" }
      }
      repository Orders for Order { }
    }
  }
  api SalesApi from D { }
  storage pg { type: postgres }
  resource st { for: Orders, kind: state, use: pg }
  deployable d { platform: elixir contexts: [Orders] dataSources: [st] serves: SalesApi port: 3000 }
}
`;
    const files = await generateSystemFiles(src);
    const mounted = scrapeRouter(files).map(key);
    const documented = [...scrapeSpec(files).keys()];
    expect(mounted).not.toContain("post /api/orders/{id}/list");
    expect(documented).not.toContain("post /api/orders/{id}/list");
    // The canonical update still rides the served loop on both halves.
    expect(mounted).toContain("post /api/orders/{id}/update");
    expect(documented).toContain("post /api/orders/{id}/update");
  });
});
