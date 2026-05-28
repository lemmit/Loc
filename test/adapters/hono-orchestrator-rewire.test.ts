// F6d — Hono orchestrator rewire — proves that the hono system orchestrator
// dispatches per-aggregate routes emission through the layered
// StyleAdapter + byLayer LayoutAdapter when running in system mode.
// The byte-identical guarantee comes from the existing TypeScript
// generator fixture suite (test/generator/typescript/*) + the
// page-emitter byte-equivalence fixture suite (which captures the
// generated hono project under test/fixtures/baseline-output/).

import { describe, expect, it, vi } from "vitest";
import * as byLayerModule from "../../src/platform/hono/v4/adapters/by-layer-layout.js";
import * as layeredStyleModule from "../../src/platform/hono/v4/adapters/layered-style.js";
import { generateTypeScript } from "../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS } from "../../src/platform/hono/v4/pins.js";
import { generateSystems } from "../../src/system/index.js";
import { parseValid } from "../_helpers/parse.js";

const SYSTEM_SRC = `
system Sys {
  subdomain Sales {
    context Orders {
      aggregate Order {
        name: string
        invariant name.length > 0
      }
      repository Orders for Order {
        find byName(name: string): Order? where this.name == name
      }
    }
  }
  storage primary { type: postgres }
  dataSource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: hono
    contexts: [Orders]
    dataSources: [ordersState]
    port: 3000
  }
}
`;

// Legacy single-context source — no `system` declaration.  Triggers
// the orchestrator's non-system path which keeps the direct
// `buildRoutesFile` call.
const LEGACY_SRC = `
context Orders {
  aggregate Order {
    name: string
  }
  repository Orders for Order {}
}
`;

describe("F6d — hono orchestrator rewire (system mode)", () => {
  it("dispatches the routes file through layeredStyleAdapter.emitForAggregate", async () => {
    const spy = vi.spyOn(layeredStyleModule.layeredStyleAdapter, "emitForAggregate");
    try {
      const files = (await generateSystems(await parseValid(SYSTEM_SRC))).files;
      expect(spy).toHaveBeenCalled();
      const call = spy.mock.calls[0]!;
      const agg = call[0]!;
      expect((agg as { name: string }).name).toBe("Order");
      // Dispatched output lands at the byLayer path.
      const routesPath = [...files.keys()].find((k) => k.endsWith("/http/order.routes.ts"));
      expect(routesPath).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("routes the dispatched artifact through byLayerLayoutAdapter.pathFor with the http-routes category", async () => {
    const layoutSpy = vi.spyOn(byLayerModule.byLayerLayoutAdapter, "pathFor");
    try {
      await generateSystems(await parseValid(SYSTEM_SRC));
      expect(layoutSpy.mock.calls.length).toBeGreaterThan(0);
      const httpRoutesCalls = layoutSpy.mock.calls.filter(
        (c) => (c[0] as { category?: string }).category === "http-routes",
      );
      expect(httpRoutesCalls.length).toBeGreaterThan(0);
    } finally {
      layoutSpy.mockRestore();
    }
  });
});

describe("F6d — hono orchestrator (legacy single-context mode)", () => {
  it("keeps the direct buildRoutesFile path when no system is in scope", async () => {
    const spy = vi.spyOn(layeredStyleModule.layeredStyleAdapter, "emitForAggregate");
    try {
      const files = generateTypeScript(await parseValid(LEGACY_SRC), BACKEND_PINS);
      // The adapter was NOT invoked — legacy path stays inline.
      expect(spy).not.toHaveBeenCalled();
      // The legacy path still produces the routes file.
      expect(files.has("http/order.routes.ts")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
