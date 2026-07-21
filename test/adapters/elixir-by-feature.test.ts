// byFeature — real LayoutAdapter for phoenixLiveView (F7c).  Pins
// every category to the exact path the existing Phoenix orchestrator
// writes today.  Verified against
// `generate system web/src/examples/storefront-elixir.ddd`.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import {
  byFeatureLayoutAdapter,
  type PhoenixArtifact,
} from "../../src/generator/elixir/adapters/by-feature-layout.js";
import { resolveLayout } from "../../src/platform/resolve-adapters.js";

// The phoenix paths are deployable-scoped — pathFor reads
// `ctx.deployable.name` to derive the snake-case app prefix.  We
// fabricate a minimal ctx with just the deployable name set so the
// path-only adapter doesn't need the full enrichment pipeline.
const ctxFor = (deployableName: string): EmitCtx =>
  ({ deployable: { name: deployableName } }) as unknown as EmitCtx;

const ctx = ctxFor("webApp"); // snakes to `web_app`

function p(
  a: Partial<PhoenixArtifact> & { name: string; category: PhoenixArtifact["category"] },
): string {
  return byFeatureLayoutAdapter.pathFor({ content: "", ...a } as PhoenixArtifact, ctx);
}

describe("byFeature LayoutAdapter — phoenixLiveView (real)", () => {
  it("is registered as the phoenixLiveView byFeature layout adapter", () => {
    const resolved = resolveLayout("elixir", "byFeature");
    expect(resolved).toBe(byFeatureLayoutAdapter);
    expect(resolved.name).toBe("byFeature");
  });

  it("places app-level modules under lib/<app>/", () => {
    expect(p({ name: "x", category: "application" })).toBe("lib/web_app/application.ex");
    expect(p({ name: "x", category: "repo" })).toBe("lib/web_app/repo.ex");
    expect(p({ name: "x", category: "telemetry" })).toBe("lib/web_app/telemetry.ex");
    expect(p({ name: "x", category: "log-formatter" })).toBe("lib/web_app/log_formatter.ex");
    expect(p({ name: "x", category: "jason-camel-case" })).toBe("lib/web_app/jason_camel_case.ex");
  });

  it("routes Ash domain modules under lib/<app>/<context>/", () => {
    expect(p({ name: "x", category: "domain-module", contextSnake: "storefront" })).toBe(
      "lib/web_app/storefront.ex",
    );
    expect(
      p({
        name: "x",
        category: "ash-resource",
        contextSnake: "storefront",
        aggregateSnake: "order",
      }),
    ).toBe("lib/web_app/storefront/order.ex");
    // Part resources land in the same context folder.
    expect(
      p({
        name: "x",
        category: "ash-resource",
        contextSnake: "storefront",
        aggregateSnake: "order_line",
      }),
    ).toBe("lib/web_app/storefront/order_line.ex");
  });

  it("places events / value-objects / enums in the right subfolders", () => {
    expect(
      p({ name: "order_confirmed.ex", category: "event-module", contextSnake: "storefront" }),
    ).toBe("lib/web_app/storefront/events/order_confirmed.ex");
    expect(
      p({ name: "money.ex", category: "value-object-module", contextSnake: "storefront" }),
    ).toBe("lib/web_app/storefront/money.ex");
    expect(
      p({ name: "order_status.ex", category: "enum-module", contextSnake: "storefront" }),
    ).toBe("lib/web_app/storefront/order_status.ex");
  });

  it("places workflows under per-context subfolders", () => {
    expect(
      p({ name: "checkout.ex", category: "workflow-module", contextSnake: "storefront" }),
    ).toBe("lib/web_app/storefront/workflows/checkout.ex");
  });

  it("routes web shell + endpoint + router under lib/<app>_web/", () => {
    expect(p({ name: "x", category: "web-shell" })).toBe("lib/web_app_web.ex");
    expect(p({ name: "x", category: "endpoint" })).toBe("lib/web_app_web/endpoint.ex");
    expect(p({ name: "x", category: "router" })).toBe("lib/web_app_web/router.ex");
  });

  it("routes UI components under lib/<app>_web/components/", () => {
    expect(p({ name: "x", category: "core-components" })).toBe(
      "lib/web_app_web/components/core_components.ex",
    );
    expect(p({ name: "x", category: "sidebar-component" })).toBe(
      "lib/web_app_web/components/sidebar.ex",
    );
    expect(p({ name: "x", category: "layouts-module" })).toBe(
      "lib/web_app_web/components/layouts.ex",
    );
    expect(p({ name: "x", category: "layout-app-heex" })).toBe(
      "lib/web_app_web/components/layouts/app.html.heex",
    );
    expect(p({ name: "x", category: "layout-root-heex" })).toBe(
      "lib/web_app_web/components/layouts/root.html.heex",
    );
  });

  it("routes LiveView pages under lib/<app>_web/live/", () => {
    expect(p({ name: "order_detail_live.ex", category: "live-page" })).toBe(
      "lib/web_app_web/live/order_detail_live.ex",
    );
    expect(p({ name: "home_live.ex", category: "live-page" })).toBe(
      "lib/web_app_web/live/home_live.ex",
    );
  });

  it("routes controllers + error responders under lib/<app>_web/controllers/", () => {
    expect(p({ name: "orders_controller.ex", category: "controller" })).toBe(
      "lib/web_app_web/controllers/orders_controller.ex",
    );
    expect(p({ name: "x", category: "error-html" })).toBe(
      "lib/web_app_web/controllers/error_html.ex",
    );
    expect(p({ name: "x", category: "error-json" })).toBe(
      "lib/web_app_web/controllers/error_json.ex",
    );
    expect(p({ name: "x", category: "health-controller" })).toBe(
      "lib/web_app_web/controllers/health_controller.ex",
    );
    expect(p({ name: "x", category: "openapi-controller" })).toBe(
      "lib/web_app_web/controllers/openapi_controller.ex",
    );
  });

  it("routes OpenAPI spec + schema modules under lib/<app>_web/api/", () => {
    expect(p({ name: "storefront_api_spec.ex", category: "api-spec" })).toBe(
      "lib/web_app_web/api/storefront_api_spec.ex",
    );
    expect(p({ name: "money.ex", category: "api-schema" })).toBe(
      "lib/web_app_web/api/schemas/money.ex",
    );
    expect(p({ name: "create_order_request.ex", category: "api-schema" })).toBe(
      "lib/web_app_web/api/schemas/create_order_request.ex",
    );
  });

  it("routes config + priv + rel + e2e files correctly", () => {
    expect(p({ name: "config.exs", category: "config" })).toBe("config/config.exs");
    expect(p({ name: "runtime.exs", category: "config" })).toBe("config/runtime.exs");
    expect(p({ name: "20260101000000_create_orders.exs", category: "migration" })).toBe(
      "priv/repo/migrations/20260101000000_create_orders.exs",
    );
    expect(p({ name: "x", category: "seeds" })).toBe("priv/repo/seeds.exs");
    expect(p({ name: "theme.css", category: "static-asset" })).toBe("priv/static/assets/theme.css");
    expect(p({ name: "x", category: "release-env" })).toBe("rel/env.sh.eex");
    expect(p({ name: "bin/server", category: "release-overlay" })).toBe("rel/overlays/bin/server");
    expect(p({ name: "home.ts", category: "e2e-page-object" })).toBe("e2e/pages/home.ts");
  });

  it("routes top-level project files to the root", () => {
    expect(p({ name: "x", category: "mix-exs" })).toBe("mix.exs");
    expect(p({ name: "x", category: "formatter-exs" })).toBe(".formatter.exs");
    expect(p({ name: "x", category: "dockerfile" })).toBe("Dockerfile");
    expect(p({ name: "x", category: "dockerignore" })).toBe(".dockerignore");
    expect(p({ name: ".gitkeep", category: "certs-marker" })).toBe("certs/.gitkeep");
  });

  it("derives the snake-case app prefix from the deployable name", () => {
    const ctx2 = ctxFor("storefront");
    const routed = byFeatureLayoutAdapter.pathFor(
      { name: "x", content: "", category: "application" } as PhoenixArtifact,
      ctx2,
    );
    expect(routed).toBe("lib/storefront/application.ex");
  });

  it("throws a clear error when a per-context category lacks contextSnake", () => {
    expect(() => p({ name: "x", category: "domain-module" })).toThrow(/missing contextSnake/);
    expect(() => p({ name: "x", category: "ash-resource", aggregateSnake: "order" })).toThrow(
      /missing contextSnake/,
    );
    expect(() => p({ name: "x", category: "event-module" })).toThrow(/missing contextSnake/);
  });

  it("throws when an artifact arrives without a category tag", () => {
    expect(() => byFeatureLayoutAdapter.pathFor({ name: "X.ex", content: "" }, ctx)).toThrow(
      /missing a category/,
    );
  });
});
