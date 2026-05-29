// Registry lookup — bareword `platform: <name>` resolves to the registered
// defaults; explicit `persistence: dapper` resolves to the registered (stub)
// Dapper adapter.  Verifies the F3 registry surface.

import { describe, expect, it } from "vitest";
import { AdapterNotImplementedError } from "../../src/generator/_adapters/index.js";
import {
  adaptersFor,
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
    expect(d.persistence.stateBased).toBe("efcore");
    expect(d.persistence.eventSourced).toBe("marten");
    expect(d.style).toBe("cqrs");
    expect(d.layout).toBe("byLayer");
  });

  it("exposes the hono defaults", () => {
    const d = defaultsFor("hono")!;
    expect(d.persistence.stateBased).toBe("drizzle");
    expect(d.style).toBe("layered");
    expect(d.layout).toBe("byLayer");
  });

  it("exposes the phoenixLiveView defaults", () => {
    const d = defaultsFor("phoenixLiveView")!;
    expect(d.persistence.stateBased).toBe("ashPostgres");
    expect(d.style).toBe("ash");
    expect(d.layout).toBe("byFeature");
  });

  it("resolves a bareword `platform: dotnet` to its defaults", () => {
    expect(resolvePersistence("dotnet", null, "stateBased").name).toBe("efcore");
    expect(resolvePersistence("dotnet", undefined, "stateBased").name).toBe("efcore");
    expect(resolvePersistence("dotnet", "", "stateBased").name).toBe("efcore");
    expect(resolvePersistence("dotnet", null, "eventSourced").name).toBe("marten");
    expect(resolveStyle("dotnet", null).name).toBe("cqrs");
    expect(resolveLayout("dotnet", null).name).toBe("byLayer");
  });

  it("resolves an explicit `persistence: dapper` to the stub", () => {
    const dapper = resolvePersistence("dotnet", "dapper");
    expect(dapper.name).toBe("dapper");
    // Capability fields answer; emit throws (verified in stub-throws.test.ts).
    expect(dapper.supports("postgres", "state", "stateBased")).toBe(true);
    expect(dapper.supports("postgres", "eventLog", "eventSourced")).toBe(false);
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
