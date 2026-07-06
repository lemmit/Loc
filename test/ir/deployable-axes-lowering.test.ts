import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { defaultsFor } from "../../src/platform/resolve-adapters.js";

// ---------------------------------------------------------------------------
// D-REALIZATION-AXES lowering — an absent axis normalizes to the platform
// default (sourced from the live adapter menu); a frontend carries no axes.
// The lowered `application` is the resolved ADAPTER key
// (`serviceLayer` → `layered`).
// ---------------------------------------------------------------------------

async function lowerDeployable(platformClause: string, name = "api") {
  const services = createDddServices(NodeFileSystem);
  const src = `
    system S {
      subdomain M { context C { } }
      deployable api { platform: ${platformClause}, contexts: [C], port: 3000 }
    }
  `;
  const doc = await parseHelper(services.Ddd)(src, { validation: false });
  const loom = lowerModel(doc.parseResult.value as Model);
  return loom.systems[0]!.deployables.find((x) => x.name === name)!;
}

describe("realization axes — lowering defaults", () => {
  it("bare dotnet → full default axis set", async () => {
    const d = await lowerDeployable("dotnet");
    expect(d.persistence).toBe("efcore");
    expect(d.directoryLayout).toBe("byLayer");
  });

  it("bare node → drizzle/byLayer defaults", async () => {
    const d = await lowerDeployable("node");
    expect(d.persistence).toBe("drizzle");
    expect(d.directoryLayout).toBe("byLayer");
  });

  it("bare elixir → ecto/byFeature (plain Phoenix, D-VANILLA-DEFAULT)", async () => {
    // D-ELIXIR-PLATFORM: `platform: elixir` is the canonical (and only)
    // name — the legacy `phoenix` / `phoenixLiveView` platform aliases
    // were retired.  D-VANILLA-DEFAULT: `platform: elixir` always emits
    // plain Phoenix LiveView on Ecto; the Ash foundation was removed.
    const d = await lowerDeployable("elixir");
    expect(d.persistence).toBe("ecto");
    expect(d.directoryLayout).toBe("byFeature");
  });

  it("defaults are sourced from the adapter menu, not hardcoded literals", async () => {
    const d = await lowerDeployable("dotnet");
    const def = defaultsFor("dotnet")!;
    expect(d.persistence).toBe(def.persistence.state);
    expect(d.directoryLayout).toBe(def.layout);
  });

  it("an explicit axis overrides the default; the rest stay default", async () => {
    const d = await lowerDeployable("dotnet { directoryLayout: byFeature }");
    expect(d.directoryLayout).toBe("byFeature");
    expect(d.persistence).toBe("efcore");
  });

  it("a frontend deployable carries no realization axes", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(
      `
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: W, port: 3001 }
      }
    `,
      { validation: false },
    );
    const loom = lowerModel(doc.parseResult.value as Model);
    const web = loom.systems[0]!.deployables.find((x) => x.name === "web")!;
    expect(web.persistence).toBeUndefined();
    expect(web.directoryLayout).toBeUndefined();
  });

  it("an explicit persistence override still lowers to its value on elixir", async () => {
    // ecto is the elixir default, but an explicit knob still resolves through.
    const d = await lowerDeployable("elixir { persistence: ecto }");
    expect(d.persistence).toBe("ecto");
  });
});
