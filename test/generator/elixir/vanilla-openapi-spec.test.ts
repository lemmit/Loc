import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";

// ---------------------------------------------------------------------------
// OpenAPI spec on the vanilla (plain Ecto/Phoenix) foundation — gap §11f.
//
// The other four backends auto-serve `/openapi.json` (framework-generated);
// the vanilla Phoenix backend has no auto-gen, so the spec is built explicitly
// from the IR via `OpenApiSpex` (a foundation-agnostic Phoenix library — NOT
// Ash).  Without it, `GET /openapi.json` 404s and Phoenix can't join the
// 5-backend conformance-parity diff.
//
// This pins the emitted surface:
//   - the per-Api spec module           (lib/<app>_web/api/<api>_spec.ex)
//   - a per-aggregate schema module      (lib/<app>_web/api/schemas/<name>.ex)
//   - the OpenapiController              (.../controllers/openapi_controller.ex)
//   - the `open_api_spex` hex dep        (mix.exs)
//   - the ROOT `/openapi.json` route     (router.ex — NOT under /api)
// ---------------------------------------------------------------------------

const SOURCE = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order ids guid {
        code: string
        region: string
      }
      repository Orders for Order {
        find recent(): Order[]
      }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: elixir { foundation: vanilla }
    contexts: [Orders]
    dataSources: [ordersState]
    serves: OrdersApi
    port: 4000
  }
}
`;

function file(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  expect(key, `${suffix} not emitted`).toBeDefined();
  return files.get(key!)!;
}

describe("vanilla OpenAPI spec (§11f)", () => {
  it("emits the per-Api OpenApiSpex spec module", async () => {
    const files = await generateSystemFiles(SOURCE);
    const specKey = [...files.keys()].find((k) => k.endsWith("_spec.ex") && k.includes("/api/"));
    expect(specKey, "spec module not emitted").toBeDefined();
    const spec = files.get(specKey!)!;
    expect(spec).toContain("alias OpenApiSpex.{Info, OpenApi, Server}");
    expect(spec).toContain("@behaviour OpenApi");
    expect(spec).toContain("def spec do");
    expect(spec).toContain("%OpenApi{");
    expect(spec).toContain("OpenApiSpex.resolve_schema_modules()");
  });

  it("emits a per-aggregate schema module", async () => {
    const files = await generateSystemFiles(SOURCE);
    const schema = file(files, "/api/schemas/order_response.ex");
    expect(schema).toContain("OpenApiSpex.schema(%{");
  });

  it("emits the OpenapiController serving the spec as JSON", async () => {
    const ctrl = file(await generateSystemFiles(SOURCE), "/controllers/openapi_controller.ex");
    expect(ctrl).toContain("defmodule");
    expect(ctrl).toContain(".OpenapiController do");
    expect(ctrl).toContain("def index(conn, _params) do");
    expect(ctrl).toContain('put_resp_content_type("application/json")');
    expect(ctrl).toContain(".spec()");
  });

  it("adds the open_api_spex hex dep to mix.exs", async () => {
    const mix = file(await generateSystemFiles(SOURCE), "mix.exs");
    expect(mix).toContain('{:open_api_spex, "~> 3.0"}');
  });

  it("routes GET /openapi.json at the router ROOT (not under /api)", async () => {
    const router = file(await generateSystemFiles(SOURCE), "/router.ex");
    // The spec endpoint must be a root route, served by the OpenapiController.
    expect(router).toMatch(/get "\/openapi\.json", \w+Web\.OpenapiController, :index/);
    // And it must NOT sit inside the `scope "/api"` block.
    const apiScopeIdx = router.indexOf('scope "/api"');
    const openapiIdx = router.indexOf("/openapi.json");
    expect(openapiIdx).toBeGreaterThanOrEqual(0);
    expect(openapiIdx).toBeLessThan(apiScopeIdx);
  });
});
