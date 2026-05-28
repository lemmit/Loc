// F5d — orchestrator rewire — proves that the dotnet system orchestrator
// dispatches CQRS emission through the cqrs StyleAdapter +
// byLayer LayoutAdapter when running in system mode.  The byte-
// identical guarantee comes from the existing dotnet fixture suite
// (test/generator/dotnet/*) — those tests assert the produced Map
// hasn't changed.  This file's job is to prove the dispatch path
// fires, not the path's output (which is the same as before by
// construction).
//
// The dotnet generator imports its sibling adapters directly
// (`./adapters/cqrs-style.js` / `./adapters/by-layer-layout.js`)
// rather than resolving via `platform/adapter-registry.js`, so the
// rewire test spies on the adapter modules themselves — not the
// registry.

import { describe, expect, it, vi } from "vitest";
import * as byLayerModule from "../../src/generator/dotnet/adapters/by-layer-layout.js";
import * as cqrsStyleModule from "../../src/generator/dotnet/adapters/cqrs-style.js";
import { generateDotnet } from "../../src/generator/dotnet/index.js";
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
    platform: dotnet
    contexts: [Orders]
    dataSources: [ordersState]
    port: 5000
  }
}
`;

// Legacy single-context source — no `system` declaration.  Triggers
// the orchestrator's non-system path which keeps the direct emitCqrs
// call (no EmitCtx to dispatch through).
const LEGACY_SRC = `
context Orders {
  aggregate Order {
    name: string
  }
  repository Orders for Order {}
}
`;

describe("F5d — dotnet orchestrator rewire (system mode)", () => {
  it("dispatches CQRS through cqrsStyleAdapter.emitForAggregate when system mode is active", async () => {
    const spy = vi.spyOn(cqrsStyleModule.cqrsStyleAdapter, "emitForAggregate");
    try {
      const files = (await generateSystems(await parseValid(SYSTEM_SRC))).files;
      // The adapter was invoked at least once per dotnet aggregate.
      expect(spy).toHaveBeenCalled();
      const call = spy.mock.calls[0]!;
      const agg = call[0]!;
      expect((agg as { name: string }).name).toBe("Order");
      // Sanity — the dispatched output landed in the file map at the
      // expected byLayer paths (proof that the path adapter fired too).
      const apiCsproj = [...files.keys()].find((k) => k.includes("api/Application/Orders/"));
      expect(apiCsproj).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("dispatches through both the style and layout adapter (path comes from byLayer.pathFor)", async () => {
    const layoutSpy = vi.spyOn(byLayerModule.byLayerLayoutAdapter, "pathFor");
    try {
      await generateSystems(await parseValid(SYSTEM_SRC));
      // The path adapter was called at least once for each CQRS-emitted
      // file — every produced artifact's path comes from `pathFor`.
      expect(layoutSpy.mock.calls.length).toBeGreaterThan(0);
      // Every call carries an artifact with a category — the byLayer
      // adapter requires it.
      for (const call of layoutSpy.mock.calls) {
        const artifact = call[0]! as { category?: string };
        expect(artifact.category).toBeDefined();
      }
    } finally {
      layoutSpy.mockRestore();
    }
  });
});

describe("F5d — dotnet orchestrator (legacy single-context mode)", () => {
  it("keeps the direct emitCqrs path when no system is in scope", async () => {
    const spy = vi.spyOn(cqrsStyleModule.cqrsStyleAdapter, "emitForAggregate");
    try {
      const files = generateDotnet(await parseValid(LEGACY_SRC));
      // The adapter was NOT invoked — the legacy path stays inline.
      expect(spy).not.toHaveBeenCalled();
      // The legacy path still produces the expected file set.
      expect(files.has("Application/Orders/Commands/CreateOrderCommand.cs")).toBe(true);
      expect(files.has("Api/OrdersController.cs")).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});
