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
  resolveRuntime,
  resolveStyle,
  resolveTransport,
} from "../../src/platform/resolve-adapters.js";

describe("adapter registry — lookup", () => {
  it("backends carry adapter menus; frontends don't", () => {
    expect(hasAdapters("dotnet")).toBe(true);
    expect(hasAdapters("node")).toBe(true);
    expect(hasAdapters("phoenixLiveView")).toBe(true);
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
  // reserved stub (java→axon / dotnet→marten) or a state-only adapter
  // (elixir→ashPostgres).
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
      expect(err.message).toContain("marten");
    }
  });

  it("throws for an adapter lookup against a frontend platform", () => {
    expect(() => resolvePersistence("react", null)).toThrow(AdapterNotImplementedError);
    expect(() => resolveStyle("static", null)).toThrow(AdapterNotImplementedError);
  });

  it("every registered persistence adapter is a valid PersistenceAdapter shape", () => {
    for (const platform of ["dotnet", "node", "phoenixLiveView"] as const) {
      const menu = adaptersFor(platform)!;
      for (const [name, adapter] of Object.entries(menu.persistence)) {
        expect(adapter.name).toBe(name);
        expect(Array.isArray(adapter.supportedStrategies)).toBe(true);
        expect(typeof adapter.supports).toBe("function");
      }
    }
  });

  it("every registered style adapter declares strategies + layouts", () => {
    for (const platform of ["dotnet", "node", "phoenixLiveView"] as const) {
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
    expect(availableAdapterNames("node", "persistence")).toEqual(["drizzle", "mikroorm"]);
    expect(availableAdapterNames("node", "style")).toEqual(["layered"]);
  });

  it("phoenix is 100% real", () => {
    // realization-axes-alignment.md: both foundations' data layers + styles
    // are first-class — ashPostgres/ecto on persistence, ash/layered on style
    // (sorted).  `layered` is plain Phoenix's real pipeline shape (DSL
    // `serviceLayer`); `vanilla` is a foundation, not a style.  Layout stays
    // byFeature-only (byLayer is unidiomatic for Phoenix — deferred).
    expect(availableAdapterNames("phoenixLiveView", "persistence")).toEqual([
      "ashPostgres",
      "ecto",
    ]);
    expect(availableAdapterNames("phoenixLiveView", "style")).toEqual(["ash", "layered"]);
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

describe("transport — adapter-backed axis (realization-axes-alignment.md slice 3)", () => {
  it("each backend exposes its real transport (alternatives are stubs)", () => {
    expect(availableAdapterNames("dotnet", "transport")).toEqual(["controllers"]);
    expect(availableAdapterNames("node", "transport")).toEqual(["hono"]);
    expect(availableAdapterNames("phoenixLiveView", "transport")).toEqual(["phoenix"]);
    // Reserved stubs — present in allAdapterNames, excluded from the real menu:
    // controllers (dotnet); express + fastify (node).
    expect(allAdapterNames("dotnet", "transport")).toEqual(["controllers", "minimalApi"]);
    expect(allAdapterNames("node", "transport")).toEqual(["express", "fastify", "hono"]);
  });

  it("exposes the transport default per backend", () => {
    expect(defaultsFor("dotnet")!.transport).toBe("controllers");
    expect(defaultsFor("node")!.transport).toBe("hono");
    expect(defaultsFor("phoenixLiveView")!.transport).toBe("phoenix");
  });

  it("resolves a bareword default + an explicit transport; throws on unknown", () => {
    expect(resolveTransport("dotnet", null).name).toBe("controllers");
    expect(resolveTransport("dotnet", "controllers").name).toBe("controllers");
    expect(resolveTransport("elixir", null).name).toBe("phoenix");
    // controllers is a registered stub: capability fields answer (name), so
    // resolution returns it cleanly (emit-time is where stubs throw).
    expect(resolveTransport("dotnet", "controllers").name).toBe("controllers");
  });

  it("frontends expose no transport", () => {
    expect(availableAdapterNames("react", "transport")).toEqual([]);
  });
});

describe("runtime — adapter-backed axis (realization-axes-alignment.md slice 5)", () => {
  it("each backend exposes `transactional`; actor runtimes are reserved stubs", () => {
    expect(availableAdapterNames("dotnet", "runtime")).toEqual(["transactional"]);
    expect(availableAdapterNames("node", "runtime")).toEqual(["transactional"]);
    expect(availableAdapterNames("phoenixLiveView", "runtime")).toEqual(["transactional"]);
    // Actor runtimes are registered stubs — present in allAdapterNames,
    // excluded from the real menu: orleans (dotnet), genserver (elixir),
    // worker (node — worker_threads).
    expect(allAdapterNames("dotnet", "runtime")).toEqual(["orleans", "transactional"]);
    expect(allAdapterNames("phoenixLiveView", "runtime")).toEqual(["genserver", "transactional"]);
    expect(allAdapterNames("node", "runtime")).toEqual(["transactional", "worker"]);
  });

  it("exposes the runtime default per backend (transactional)", () => {
    expect(defaultsFor("dotnet")!.runtime).toBe("transactional");
    expect(defaultsFor("node")!.runtime).toBe("transactional");
    expect(defaultsFor("phoenixLiveView")!.runtime).toBe("transactional");
  });

  it("resolves the default + an explicit runtime; reserved stubs resolve cleanly", () => {
    expect(resolveRuntime("dotnet", null).name).toBe("transactional");
    expect(resolveRuntime("elixir", "transactional").name).toBe("transactional");
    expect(resolveRuntime("dotnet", "orleans").name).toBe("orleans");
    expect(resolveRuntime("elixir", "genserver").name).toBe("genserver");
    expect(resolveRuntime("node", "worker").name).toBe("worker");
  });
});
