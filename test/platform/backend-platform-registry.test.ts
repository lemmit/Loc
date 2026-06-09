import { describe, expect, it } from "vitest";

import {
  BUILTIN_PLATFORM_LATEST,
  parseBuiltinPlatformRef,
  platformFor,
} from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// The registry resolves backends by
// family@version with a defaults map, while staying byte-identical:
// every resolution path must return the SAME surface instance the
// bareword returned before (the guarantee that no generated output
// changes).  See docs/backend-packages.md.
// ---------------------------------------------------------------------------

describe("parseBuiltinPlatformRef", () => {
  it("maps a backend bareword to its default version", () => {
    expect(parseBuiltinPlatformRef("hono")).toEqual({
      family: "node",
      version: "v4",
      qualified: "node@v4",
    });
    expect(parseBuiltinPlatformRef("dotnet")?.qualified).toBe("dotnet@v8");
    expect(parseBuiltinPlatformRef("elixir")?.qualified).toBe("elixir@v1");
    // Back-compat: legacy `phoenix` and `phoenixLiveView` alias to
    // canonical `elixir` (D-ELIXIR-PLATFORM).
    expect(parseBuiltinPlatformRef("phoenix")?.qualified).toBe("elixir@v1");
    expect(parseBuiltinPlatformRef("phoenixLiveView")?.qualified).toBe("elixir@v1");
  });

  it("parses an explicit family@version pin", () => {
    expect(parseBuiltinPlatformRef("hono@v4")).toEqual({
      family: "node",
      version: "v4",
      qualified: "node@v4",
    });
    // Version need not exist yet — the parse is purely syntactic;
    // resolution (platformFor) is what rejects unknown versions.
    expect(parseBuiltinPlatformRef("hono@v5")?.qualified).toBe("node@v5");
  });

  it("returns null for frontend / unknown platforms", () => {
    expect(parseBuiltinPlatformRef("react")).toBeNull();
    expect(parseBuiltinPlatformRef("static")).toBeNull();
    expect(parseBuiltinPlatformRef("frobnicator")).toBeNull();
  });
});

describe("platformFor — byte-identity guarantee", () => {
  it("bareword and its default pin resolve to the SAME surface", () => {
    // The crux: `platform: hono` must yield the exact instance
    // it did before the registry generalisation, so emitted output
    // is unchanged.
    expect(platformFor("hono")).toBe(platformFor("hono@v4" as never));
    expect(platformFor("dotnet")).toBe(platformFor("dotnet@v8" as never));
    expect(platformFor("elixir")).toBe(platformFor("elixir@v1" as never));
    // Back-compat: the legacy `phoenix` and `phoenixLiveView` spellings
    // resolve identically (D-ELIXIR-PLATFORM).
    expect(platformFor("phoenix")).toBe(platformFor("elixir"));
    expect(platformFor("phoenixLiveView")).toBe(platformFor("elixir"));
  });

  it("frontend platforms resolve straight through (single-version)", () => {
    // react/static aren't backend families — they version via the
    // design/stack axis, so they must NOT route through the
    // version map.  static shares the react surface (v0 behaviour).
    expect(platformFor("react")).toBe(platformFor("static"));
    expect(platformFor("react").name).toBe("react");
  });

  it("the defaults map covers exactly the backend families", () => {
    expect(Object.keys(BUILTIN_PLATFORM_LATEST).sort()).toEqual(["dotnet", "elixir", "node"]);
  });

  it("throws a clear error for an unregistered backend version", () => {
    // The legacy `hono@v5` pin desugars to the canonical `node` family
    // before resolution, so the error names `node@v5`.
    expect(() => platformFor("hono@v5" as never)).toThrow(
      /Unknown backend platform version "node@v5"/,
    );
  });
});
