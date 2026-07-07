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
    expect(hasAdapters("node")).toBe(true);
    expect(hasAdapters("elixir")).toBe(true);
    expect(hasAdapters("react")).toBe(false);
    expect(hasAdapters("static")).toBe(false);
  });

  it("exposes the .NET defaults", () => {
    const d = defaultsFor("dotnet")!;
    expect(d.persistence.state).toBe("efcore");
    // DEBT-20: eventLog default must be a REAL adapter, not the `marten` stub.
    expect(d.persistence.eventLog).toBe("efcore");
    expect(d.style).toBe("cqrs");
    expect(d.layout).toBe("byLayer");
  });

  // DEBT-20: a backend's *default* eventLog adapter must be REAL (it has to
  // actually emit an event-sourced store when an event-sourced aggregate omits
  // an explicit `persistence:`).  Guards against a default pointing back at a
  // reserved stub (java→axon / dotnet→marten) or a state-only adapter.
  it.each([
    "node",
    "dotnet",
    "java",
    "elixir",
  ] as const)("%s default eventLog adapter is real and advertises eventLog", (platform) => {
    const name = defaultsFor(platform)!.persistence.eventLog;
    // `availableAdapterNames` lists REAL adapters only (stubs excluded).
    expect(availableAdapterNames(platform, "persistence")).toContain(name);
    const adapter = resolvePersistence(platform, name, "eventLog");
    expect(adapter.supportedStrategies).toContain("eventLog");
  });

  it("exposes the node defaults", () => {
    const d = defaultsFor("node")!;
    expect(d.persistence.state).toBe("drizzle");
    expect(d.style).toBe("layered");
    expect(d.layout).toBe("byLayer");
  });

  it("exposes the elixir defaults", () => {
    const d = defaultsFor("elixir")!;
    expect(d.persistence.state).toBe("ecto");
    expect(d.style).toBe("layered");
    expect(d.layout).toBe("byFeature");
  });

  it("resolves a bareword `platform: dotnet` to its defaults", () => {
    expect(resolvePersistence("dotnet", null, "state").name).toBe("efcore");
    expect(resolvePersistence("dotnet", undefined, "state").name).toBe("efcore");
    expect(resolvePersistence("dotnet", "", "state").name).toBe("efcore");
    // DEBT-20: the eventLog default resolves to the real efcore adapter, not the
    // marten stub (an event-sourced aggregate with no explicit `persistence:`
    // must land on an adapter that actually emits the store).
    expect(resolvePersistence("dotnet", null, "eventLog").name).toBe("efcore");
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
    }
  });

  it("throws for an adapter lookup against a frontend platform", () => {
    expect(() => resolvePersistence("react", null)).toThrow(AdapterNotImplementedError);
    expect(() => resolveStyle("static", null)).toThrow(AdapterNotImplementedError);
  });

  it("every registered persistence adapter is a valid PersistenceAdapter shape", () => {
    for (const platform of ["dotnet", "node", "elixir"] as const) {
      const menu = adaptersFor(platform)!;
      for (const [name, adapter] of Object.entries(menu.persistence)) {
        expect(adapter.name).toBe(name);
        expect(Array.isArray(adapter.supportedStrategies)).toBe(true);
        expect(typeof adapter.supports).toBe("function");
      }
    }
  });

  it("every registered style adapter declares strategies + layouts", () => {
    for (const platform of ["dotnet", "node", "elixir"] as const) {
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
  it("dotnet menu is efcore/dapper persistence · cqrs style · byLayer/byFeature layout (all real)", () => {
    // dapper became real in Phase 5c — both persistence adapters selectable.
    expect(availableAdapterNames("dotnet", "persistence")).toEqual(["dapper", "efcore"]);
    expect(availableAdapterNames("dotnet", "style")).toEqual(["cqrs"]);
    // byFeature became real in Phase 5a — both layouts are now selectable.
    expect(availableAdapterNames("dotnet", "layout")).toEqual(["byFeature", "byLayer"]);
  });

  it("excludes stubs on hono (drizzle/mikroorm/layered/byLayer real)", () => {
    // mikroorm became real in Phase 5d — the node persistence menu is now
    // exactly { drizzle, mikroorm } (the speculative prisma stub was removed).
    expect(availableAdapterNames("node", "persistence")).toEqual(["drizzle", "mikroorm"]);
    expect(availableAdapterNames("node", "style")).toEqual(["layered"]);
  });

  it("phoenix is 100% real", () => {
    // realization-axes-alignment.md: the plain Ecto/Phoenix data layer + style
    // are first-class — `ecto` on persistence, `layered` on style.  `layered` is
    // plain Phoenix's real pipeline shape (DSL `serviceLayer`); `vanilla` is a
    // foundation, not a style.  Layout stays byFeature-only (byLayer is
    // unidiomatic for Phoenix — deferred).  The Ash data layer / style were
    // removed.
    expect(availableAdapterNames("elixir", "persistence")).toEqual(["ecto"]);
    expect(availableAdapterNames("elixir", "style")).toEqual(["layered"]);
    expect(availableAdapterNames("elixir", "layout")).toEqual(["byFeature"]);
  });

  it("frontends expose no adapter names", () => {
    expect(availableAdapterNames("react", "persistence")).toEqual([]);
    expect(availableAdapterNames("static", "style")).toEqual([]);
  });

  it("allAdapterNames equals availableAdapterNames — no reserved stubs remain", () => {
    // All stub adapters were removed, so the full menu is exactly the real menu.
    const all = allAdapterNames("dotnet", "persistence");
    expect(all).toContain("efcore"); // real
    expect(all).toContain("dapper"); // real since Phase 5c
    expect(all).not.toContain("marten"); // the marten stub was removed
    expect(all).toEqual(availableAdapterNames("dotnet", "persistence"));
  });
});
