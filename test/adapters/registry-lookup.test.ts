// Registry lookup — bareword `platform: <name>` resolves to the registered
// defaults; explicit `persistence: dapper` resolves to the registered (stub)
// Dapper adapter.  Verifies the F3 registry surface.

import { describe, expect, it } from "vitest";
import { AdapterNotImplementedError } from "../../src/generator/_adapters/index.js";
import {
  adaptersFor,
  allAdapterNames,
  availableAdapterNames,
  defaultsFor,
  hasAdapters,
  resolveLayout,
  resolvePersistence,
  resolveStyle,
} from "../../src/platform/resolve-adapters.js";

describe("adapter registry — lookup", () => {
  it("backends carry adapter menus; frontends don't", () => {
    expect(hasAdapters("dotnet")).toBe(true);
    expect(hasAdapters("hono")).toBe(true);
    expect(hasAdapters("phoenixLiveView")).toBe(true);
    expect(hasAdapters("react")).toBe(false);
    expect(hasAdapters("static")).toBe(false);
  });

  it("exposes the .NET defaults", () => {
    const d = defaultsFor("dotnet")!;
    expect(d.persistence.state).toBe("efcore");
    expect(d.persistence.eventLog).toBe("marten");
    expect(d.style).toBe("cqrs");
    expect(d.layout).toBe("byLayer");
  });

  it("exposes the hono defaults", () => {
    const d = defaultsFor("hono")!;
    expect(d.persistence.state).toBe("drizzle");
    expect(d.style).toBe("layered");
    expect(d.layout).toBe("byLayer");
  });

  it("exposes the phoenixLiveView defaults", () => {
    const d = defaultsFor("phoenixLiveView")!;
    expect(d.persistence.state).toBe("ashPostgres");
    expect(d.style).toBe("ash");
    expect(d.layout).toBe("byFeature");
  });

  it("resolves a bareword `platform: dotnet` to its defaults", () => {
    expect(resolvePersistence("dotnet", null, "state").name).toBe("efcore");
    expect(resolvePersistence("dotnet", undefined, "state").name).toBe("efcore");
    expect(resolvePersistence("dotnet", "", "state").name).toBe("efcore");
    expect(resolvePersistence("dotnet", null, "eventLog").name).toBe("marten");
    expect(resolveStyle("dotnet", null).name).toBe("cqrs");
    expect(resolveLayout("dotnet", null).name).toBe("byLayer");
  });

  it("resolves an explicit `persistence: dapper` to the stub", () => {
    const dapper = resolvePersistence("dotnet", "dapper");
    expect(dapper.name).toBe("dapper");
    // Capability fields answer; emit throws (verified in stub-throws.test.ts).
    expect(dapper.supports("postgres", "state", "state")).toBe(true);
    // Event sourcing (appliers, Dapper edition) is now supported.
    expect(dapper.supports("postgres", "eventLog", "eventLog")).toBe(true);
  });

  it("rejects an unknown adapter name with the error listing siblings", () => {
    try {
      resolvePersistence("dotnet", "nopeql");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AdapterNotImplementedError);
      const err = e as AdapterNotImplementedError;
      expect(err.adapterName).toBe("nopeql");
      expect(err.message).toContain("dapper");
      expect(err.message).toContain("efcore");
      expect(err.message).toContain("marten");
    }
  });

  it("throws for an adapter lookup against a frontend platform", () => {
    expect(() => resolvePersistence("react", null)).toThrow(AdapterNotImplementedError);
    expect(() => resolveStyle("static", null)).toThrow(AdapterNotImplementedError);
  });

  it("every registered persistence adapter is a valid PersistenceAdapter shape", () => {
    for (const platform of ["dotnet", "hono", "phoenixLiveView"] as const) {
      const menu = adaptersFor(platform)!;
      for (const [name, adapter] of Object.entries(menu.persistence)) {
        expect(adapter.name).toBe(name);
        expect(Array.isArray(adapter.supportedStrategies)).toBe(true);
        expect(typeof adapter.supports).toBe("function");
      }
    }
  });

  it("every registered style adapter declares strategies + layouts", () => {
    for (const platform of ["dotnet", "hono", "phoenixLiveView"] as const) {
      const menu = adaptersFor(platform)!;
      for (const [name, adapter] of Object.entries(menu.styles)) {
        expect(adapter.name).toBe(name);
        expect(Array.isArray(adapter.supportedStrategies)).toBe(true);
        expect(Array.isArray(adapter.supportedLayouts)).toBe(true);
      }
    }
  });
});

describe("availableAdapterNames — real adapters only (D-REALIZATION-AXES R1 menu)", () => {
  it("excludes stubs on dotnet (efcore/dapper/cqrs/byLayer/byFeature real; marten/layered stubs)", () => {
    // dapper became real in Phase 5c — both persistence adapters selectable.
    expect(availableAdapterNames("dotnet", "persistence")).toEqual(["dapper", "efcore"]);
    expect(availableAdapterNames("dotnet", "style")).toEqual(["cqrs"]);
    // byFeature became real in Phase 5a — both layouts are now selectable.
    expect(availableAdapterNames("dotnet", "layout")).toEqual(["byFeature", "byLayer"]);
  });

  it("excludes stubs on hono (drizzle/mikroorm/layered/byLayer real)", () => {
    // mikroorm became real in Phase 5d — the node persistence menu is now
    // exactly { drizzle, mikroorm } (the speculative prisma stub was removed).
    expect(availableAdapterNames("hono", "persistence")).toEqual(["drizzle", "mikroorm"]);
    expect(availableAdapterNames("hono", "style")).toEqual(["layered"]);
  });

  it("phoenix is 100% real", () => {
    // realization-axes-alignment.md: both foundations' data layers + styles
    // are first-class — ashPostgres/ecto on persistence, ash/vanilla on style
    // (sorted).  Layout stays byFeature-only (byLayer is unidiomatic for
    // Phoenix — deferred).
    expect(availableAdapterNames("phoenixLiveView", "persistence")).toEqual([
      "ashPostgres",
      "ecto",
    ]);
    expect(availableAdapterNames("phoenixLiveView", "style")).toEqual(["ash", "vanilla"]);
    expect(availableAdapterNames("phoenixLiveView", "layout")).toEqual(["byFeature"]);
  });

  it("frontends expose no adapter names", () => {
    expect(availableAdapterNames("react", "persistence")).toEqual([]);
    expect(availableAdapterNames("static", "style")).toEqual([]);
  });

  it("allAdapterNames includes reserved stubs (so 'reserved' can be told from 'unknown')", () => {
    const all = allAdapterNames("dotnet", "persistence");
    expect(all).toContain("efcore"); // real
    expect(all).toContain("dapper"); // real since Phase 5c
    expect(all).toContain("marten"); // a registered stub
    expect(availableAdapterNames("dotnet", "persistence")).not.toContain("marten");
  });
});
