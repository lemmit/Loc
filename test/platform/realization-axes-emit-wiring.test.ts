// D-REALIZATION-AXES Phase 4 — the codegen-consumption keystone.
//
// Proves the per-deployable `application:` (→ style) and
// `directoryLayout:` (→ layout) selection is THREADED end-to-end: the
// system orchestrator resolves it via `resolve-adapters`, passes it into
// `PlatformSurface.emitProject`, which forwards it into the generator's
// `EmitCtx`, where the per-aggregate dispatch uses it instead of the
// hardcoded sibling default.
//
// We can't observe a *different* output from a real selection yet (the
// menus are size-1 — the only real style/layout IS the default; that
// byte-identity is locked by the baseline-fixture test).  So we inject a
// SENTINEL adapter through the public `emitProject` arg and assert its
// output reaches the emitted file map — the wiring, not the menu.

import { describe, expect, it } from "vitest";
import type {
  EmittedArtifact,
  LayoutAdapter,
  StyleAdapter,
} from "../../src/generator/_adapters/index.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import type { EnrichedBoundedContextIR } from "../../src/ir/types/loom-ir.js";
import dotnetPlatform from "../../src/platform/dotnet.js";
import phoenixPlatform from "../../src/platform/elixir.js";
import honoPlatform from "../../src/platform/hono/v4/index.js";
import type { PlatformSurface } from "../../src/platform/surface.js";
import { parseValid } from "../_helpers/parse.js";

const SRC = (platform: string) => `
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
  resource ordersState { for: Orders, kind: state, use: primary }
  deployable api {
    platform: ${platform}
    contexts: [Orders]
    dataSources: [ordersState]
    port: 3000
  }
}
`;

async function emitInputs(platform: string) {
  const loom = enrichLoomModel(lowerModel(await parseValid(SRC(platform))));
  const sys = loom.systems[0]!;
  const deployable = sys.deployables[0]!;
  const all: EnrichedBoundedContextIR[] = sys.subdomains.flatMap((s) => s.contexts);
  const contexts = all.filter((c) => deployable.contextNames.includes(c.name));
  return { contexts, deployable, sys };
}

const SENTINEL_PATH = "Sentinel/marker.txt";
const SENTINEL_BODY = "// sentinel-style-output";

/** A style whose per-aggregate emit returns one marker artifact. */
function sentinelStyle(): StyleAdapter {
  return {
    name: "sentinel",
    supportedStrategies: ["state"],
    supportedLayouts: ["byLayer", "byFeature"],
    emitEndpoint: () => [],
    emitHandlerOrService: () => [],
    // Marker DI line — observed in the Phoenix config (which splices
    // `emitDi` output into config/config.exs).
    emitDi: () => ["# sentinel-di-line"],
    emitForAggregate: (agg): readonly EmittedArtifact[] => [
      { name: `${agg.name}-marker`, content: SENTINEL_BODY, category: "sentinel" },
    ],
  };
}

/** A layout that routes every artifact to one fixed sentinel path. */
function sentinelLayout(): LayoutAdapter {
  return { name: "sentinel-layout", pathFor: () => SENTINEL_PATH };
}

/** Backends whose orchestrator dispatches per-aggregate through the
 *  resolved style + layout (dotnet, node). */
describe.each([
  ["dotnet", dotnetPlatform as PlatformSurface],
  ["node", honoPlatform as PlatformSurface],
])("style + layout threading — %s", (platform, surface) => {
  it("routes per-aggregate emission through the THREADED style + layout", async () => {
    const { contexts, deployable, sys } = await emitInputs(platform);
    const files = surface.emitProject({
      contexts,
      deployable,
      sys,
      migrations: [],
      styleAdapter: sentinelStyle(),
      layoutAdapter: sentinelLayout(),
    });
    // The injected adapters' output reached the file map at the layout's
    // chosen path — proving emitProject → generator → EmitCtx → dispatch.
    expect(files.get(SENTINEL_PATH)).toBe(SENTINEL_BODY);
  });

  it("falls back to the sibling default when no adapter is threaded", async () => {
    const { contexts, deployable, sys } = await emitInputs(platform);
    const files = surface.emitProject({ contexts, deployable, sys, migrations: [] });
    // No sentinel; the backend's own CQRS/layered + byLayer paths emit.
    expect(files.has(SENTINEL_PATH)).toBe(false);
    expect(files.size).toBeGreaterThan(0);
  });
});

describe("style threading — phoenix", () => {
  it("dispatches config DI through the THREADED style adapter", async () => {
    const { contexts, deployable, sys } = await emitInputs("elixir");
    const files = (phoenixPlatform as PlatformSurface).emitProject({
      contexts,
      deployable,
      sys,
      migrations: [],
      styleAdapter: sentinelStyle(),
    });
    // Phoenix splices `style.emitDi(ctx)` into config/config.exs.
    expect(files.get("config/config.exs")).toContain("# sentinel-di-line");
  });

  it("falls back to ashStyleAdapter when no adapter is threaded", async () => {
    const { contexts, deployable, sys } = await emitInputs("elixir");
    const files = (phoenixPlatform as PlatformSurface).emitProject({
      contexts,
      deployable,
      sys,
      migrations: [],
    });
    expect(files.get("config/config.exs")).not.toContain("# sentinel-di-line");
  });
});

// A guard at the resolution seam: the backend's DEFAULT axis keys are the
// ones the system orchestrator resolves to — so the threaded value under
// no explicit selection is the same sibling default the generator falls
// back to (the byte-identity the baseline-fixture test locks).
describe("default selection keys match the sibling defaults", () => {
  it("dotnet application default key is `cqrs`, layout `byLayer`", () => {
    const defs = dotnetPlatform.adapterDefaults?.();
    expect(defs?.style).toBe("cqrs");
    expect(defs?.layout).toBe("byLayer");
  });
  it("phoenix application default key is `ash`", () => {
    expect(phoenixPlatform.adapterDefaults?.().style).toBe("ash");
  });
});
