import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// F15 — `serves:` is optional, and it only ever named the spec MODULE.
//
// `emitOpenApiSpec` used to return early on an empty `serves`, so a deployable
// declared with `contexts:` alone published no spec module, no
// `OpenapiController` and no `/openapi.json` route at all — while the other
// four backends publish a route-derived document either way.  Both shared
// schemathesis fixtures declare `contexts:` only, which is why the elixir leg
// has to run its own `ELIXIR_CASES` fixture set
// (`docs/audits/schemathesis-findings-2026-08.md`, F15).
//
// The document's CONTENT is derived from the hosted contexts, never from the
// `api` declaration, so the fallback must change the NAME and nothing else.
// The last case here pins exactly that, by differencing the two emissions.
// ---------------------------------------------------------------------------

/** The F15 fixture, with and without the `api` declaration + `serves:` clause. */
function f15Source(opts: { serves: boolean }): string {
  return `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order {
        code: string
        region: string
        operation cancel(reason: string) { }
      }
      repository Orders for Order {
        find recent(): Order[]
      }
    }
  }
${opts.serves ? "  api OrdersApi from Sales\n" : ""}  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir
    contexts: [Orders]
    dataSources: [ordersState]
${opts.serves ? "    serves: OrdersApi\n" : ""}    port: 4000
  }
}
`;
}

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla OpenAPI spec — a deployable without `serves:` (F15)", () => {
  it("still emits the spec module, named after the app", async () => {
    const files = await generateSystemFiles(f15Source({ serves: false }));
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    expect(specKey, "spec module not emitted for a contexts-only deployable").toBeDefined();
    expect(specKey).toBe("api/lib/api_web/api/api_spec.ex");
    const spec = files.get(specKey!)!;
    expect(spec).toContain("defmodule ApiWeb.Api.ApiSpec do");
    expect(spec).toContain("@behaviour OpenApi");
    expect(spec).toContain("OpenApiSpex.resolve_schema_modules()");
    // The schema modules its paths reference come with it.
    expect(files.has("api/lib/api_web/api/schemas/order_response.ex")).toBe(true);
    expect(files.has("api/lib/api_web/api/schemas/problem_details.ex")).toBe(true);
  });

  it("still emits the OpenapiController and the ROOT /openapi.json route", async () => {
    const files = await generateSystemFiles(f15Source({ serves: false }));
    const ctrl = file(files, "/controllers/openapi_controller.ex");
    expect(ctrl).toContain("defmodule ApiWeb.OpenapiController do");
    expect(ctrl).toContain("ApiWeb.Api.ApiSpec.spec()");
    const router = file(files, "/router.ex");
    expect(router).toMatch(/get "\/openapi\.json", \w+Web\.OpenapiController, :index/);
    // Root route, not inside `scope "/api"` — same placement as the served case.
    const apiScopeIdx = router.indexOf('scope "/api"');
    const openapiIdx = router.indexOf("/openapi.json");
    expect(openapiIdx).toBeGreaterThanOrEqual(0);
    expect(openapiIdx).toBeLessThan(apiScopeIdx);
  });

  it("publishes every route the router actually mounts under /api", async () => {
    const files = await generateSystemFiles(f15Source({ serves: false }));
    const router = file(files, "/router.ex");
    const spec = files.get("api/lib/api_web/api/api_spec.ex")!;
    // The document is served relative to /api …
    expect(spec).toContain('servers: [%Server{url: "/api"}]');
    // … and every route the `scope "/api"` block mounts has a matching path item.
    const apiScope = router.slice(router.indexOf('scope "/api"'), router.lastIndexOf('scope "/"'));
    const mounted = [...apiScope.matchAll(/^\s+(get|post|put|patch|delete) "([^"]+)"/gm)].map(
      (m) => [m[1]!, m[2]!.replace(/:(\w+)/g, "{$1}")] as const,
    );
    expect(
      mounted.length,
      "no /api routes mounted — the fixture is not exercising this",
    ).toBeGreaterThan(0);
    for (const [verb, path] of mounted) {
      const at = spec.indexOf(`"${path}" => %OpenApiSpex.PathItem{`);
      expect(
        at,
        `spec is missing a path item for ${verb.toUpperCase()} ${path}`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        spec.slice(at, spec.indexOf("\n      }", at)),
        `path item ${path} does not declare ${verb}`,
      ).toContain(`${verb}: %OpenApiSpex.Operation{`);
    }
    // The CRUD + find + operation surface this fixture mounts, spelled out.
    expect(mounted.map(([v, p]) => `${v} ${p}`)).toEqual([
      "get /orders",
      "get /orders/recent",
      "get /orders/{id}",
      "post /orders/{id}/cancel",
    ]);
  });

  it("changes NOTHING but the spec module's name when `serves:` IS declared", async () => {
    const served = await generateSystemFiles(f15Source({ serves: true }));
    const unserved = await generateSystemFiles(f15Source({ serves: false }));

    // `serves:` still names the spec — the pre-F15 behaviour, unchanged.
    expect(served.has("api/lib/api_web/api/orders_api_spec.ex")).toBe(true);
    expect(served.get("api/lib/api_web/api/orders_api_spec.ex")!).toContain(
      "defmodule ApiWeb.Api.OrdersApiSpec do",
    );

    // Difference the two emissions over the elixir project.  Only the spec
    // module's PATH and its module alias may differ — every other emitted byte,
    // the OpenapiController and the router included, must be identical.
    const rename = (s: string) => s.replaceAll("OrdersApiSpec", "ApiSpec");
    const norm = (m: Map<string, string>) =>
      new Map(
        [...m]
          .filter(([k]) => k.startsWith("api/"))
          .map(([k, v]) => [k.replace("/api/orders_api_spec.ex", "/api/api_spec.ex"), rename(v)]),
      );
    const withServes = norm(served);
    const withoutServes = norm(unserved);
    expect([...withoutServes.keys()].sort()).toEqual([...withServes.keys()].sort());
    for (const [k, v] of withServes) expect(withoutServes.get(k), `${k} differs`).toBe(v);
  });
});
