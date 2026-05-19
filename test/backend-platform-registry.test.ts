import { describe, it, expect } from "vitest";

import {
  BUILTIN_PLATFORM_LATEST,
  parseBuiltinPlatformRef,
  platformFor,
} from "../src/platform/registry.js";

// ---------------------------------------------------------------------------
// Backend-packages B0 — the registry resolves backends by
// family@version with a defaults map, while staying byte-identical:
// every resolution path must return the SAME surface instance the
// bareword returned pre-B0 (the guarantee that no generated output
// changes).  See docs/backend-packages.md.
// ---------------------------------------------------------------------------

describe("parseBuiltinPlatformRef", () => {
  it("maps a backend bareword to its default version", () => {
    expect(parseBuiltinPlatformRef("hono")).toEqual({
      family: "hono",
      version: "v4",
      qualified: "hono@v4",
    });
    expect(parseBuiltinPlatformRef("dotnet")?.qualified).toBe("dotnet@v8");
    expect(parseBuiltinPlatformRef("phoenixLiveView")?.qualified).toBe(
      "phoenixLiveView@v1",
    );
  });

  it("parses an explicit family@version pin", () => {
    expect(parseBuiltinPlatformRef("hono@v4")).toEqual({
      family: "hono",
      version: "v4",
      qualified: "hono@v4",
    });
    // Version need not exist yet — the parse is purely syntactic;
    // resolution (platformFor) is what rejects unknown versions.
    expect(parseBuiltinPlatformRef("hono@v5")?.qualified).toBe("hono@v5");
  });

  it("returns null for frontend / unknown platforms", () => {
    expect(parseBuiltinPlatformRef("react")).toBeNull();
    expect(parseBuiltinPlatformRef("static")).toBeNull();
    expect(parseBuiltinPlatformRef("frobnicator")).toBeNull();
  });
});

describe("platformFor — byte-identity guarantee", () => {
  it("bareword and its default pin resolve to the SAME surface", () => {
    // The crux of B0: `platform: hono` must yield the exact instance
    // it did before the registry generalisation, so emitted output
    // is unchanged.
    expect(platformFor("hono")).toBe(platformFor("hono@v4" as never));
    expect(platformFor("dotnet")).toBe(platformFor("dotnet@v8" as never));
    expect(platformFor("phoenixLiveView")).toBe(
      platformFor("phoenixLiveView@v1" as never),
    );
  });

  it("frontend platforms resolve straight through (single-version)", () => {
    // react/static aren't backend families — they version via the
    // design/stack axis, so they must NOT route through the
    // version map.  static shares the react surface (v0 behaviour).
    expect(platformFor("react")).toBe(platformFor("static"));
    expect(platformFor("react").name).toBe("react");
  });

  it("the defaults map covers exactly the backend families", () => {
    expect(Object.keys(BUILTIN_PLATFORM_LATEST).sort()).toEqual([
      "dotnet",
      "hono",
      "phoenixLiveView",
    ]);
  });

  it("throws a clear error for an unregistered backend version", () => {
    expect(() => platformFor("hono@v5" as never)).toThrow(
      /Unknown backend platform version "hono@v5"/,
    );
  });
});
