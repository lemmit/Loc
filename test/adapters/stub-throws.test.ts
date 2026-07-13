// AdapterNotImplementedError + stubAdapter — capability fields answer
// directly, `emit*` methods throw with the documented message.

import { describe, expect, it } from "vitest";
import {
  AdapterNotImplementedError,
  type LayoutAdapter,
  type PersistenceAdapter,
  type StyleAdapter,
  stubAdapter,
} from "../../src/generator/_adapters/index.js";

describe("stubAdapter", () => {
  it("answers capability fields directly without calling realImplementations", () => {
    let listed = 0;
    const stub = stubAdapter<PersistenceAdapter>(
      "persistence",
      "dapper",
      "dotnet",
      () => {
        listed++;
        return ["efcore", "marten"];
      },
      {
        name: "dapper",
        supportedStrategies: ["state"],
        supports: (type) => type === "postgres",
      },
    );
    expect(stub.name).toBe("dapper");
    expect(stub.supportedStrategies).toEqual(["state"]);
    expect(stub.supports("postgres", "state", "state")).toBe(true);
    expect(stub.supports("redis", "state", "state")).toBe(false);
    // realImplementations() is only invoked on a throwing `emit*` call.
    expect(listed).toBe(0);
  });

  it("throws AdapterNotImplementedError from a non-capability method call", () => {
    // The stub proxy answers capability fields and throws on ANY other
    // string-keyed access.  `emitProjectDeps` (the one live emit method) is
    // not a capability field, so it exercises the throwing path.  (The heavy
    // emit* methods were removed — M-T9.2 / M-T6.10 — so they no longer need
    // per-method assertions here.)
    const stub = stubAdapter<PersistenceAdapter>(
      "persistence",
      "dapper",
      "dotnet",
      () => ["efcore", "marten"],
      {
        name: "dapper",
        supportedStrategies: ["state"],
        supports: () => true,
      },
    );
    const ctx = {} as never;
    expect(() => stub.emitProjectDeps(ctx)).toThrow(AdapterNotImplementedError);
  });

  it("error message lists sibling implementations (lazily, sorted)", () => {
    const stub = stubAdapter<PersistenceAdapter>(
      "persistence",
      "dapper",
      "dotnet",
      () => ["marten", "efcore"], // intentionally unsorted
      { name: "dapper", supportedStrategies: ["state"], supports: () => false },
    );
    try {
      stub.emitProjectDeps({} as never);
    } catch (e) {
      const err = e as AdapterNotImplementedError;
      expect(err).toBeInstanceOf(AdapterNotImplementedError);
      expect(err.adapterKind).toBe("persistence");
      expect(err.adapterName).toBe("dapper");
      expect(err.platformName).toBe("dotnet");
      expect(err.message).toContain("persistence adapter 'dapper' is not yet implemented");
      expect(err.message).toContain("platform 'dotnet'");
      expect(err.message).toContain("efcore, marten"); // sorted
    }
  });

  it("falls back to 'No implementations…' when the sibling list is empty", () => {
    const stub = stubAdapter<StyleAdapter>("style", "fancy", "phoenixLiveView", () => [], {
      name: "fancy",
      supportedStrategies: ["state"],
      supportedLayouts: ["byFeature"],
    });
    try {
      stub.emitDi({} as never);
    } catch (e) {
      const err = e as AdapterNotImplementedError;
      expect(err.message).toContain("No implementations of this style are available yet.");
    }
  });

  it("works for layout adapters (capability-only contract)", () => {
    const stub = stubAdapter<LayoutAdapter>("layout", "byFeature", "dotnet", () => ["byLayer"], {
      name: "byFeature",
    });
    expect(stub.name).toBe("byFeature");
    expect(() => stub.pathFor({ name: "X", content: "" }, {} as never)).toThrow(
      AdapterNotImplementedError,
    );
  });
});
