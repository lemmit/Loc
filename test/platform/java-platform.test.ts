// ---------------------------------------------------------------------------
// Java platform surface + registry wiring (slice S1 of
// docs/old/plans/java-backend-implementation.md): `platform: java` resolves
// through the registry as `java@v1`, the surface carries the dotnet-like
// dual-mode flags, and the adapter menu exposes jpa/layered/byLayer/
// byFeature as real with jooq/axon/cqrs reserved as stubs.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { parseBuiltinPlatformRef, platformFor } from "../../src/platform/registry.js";
import {
  allAdapterNames,
  availableAdapterNames,
  defaultsFor,
} from "../../src/platform/resolve-adapters.js";

// NOTE: the surface is reached through `platformFor`, never by importing
// `src/platform/java.js` directly — a direct import ahead of the registry
// re-enters the tolerated `registry → surface → generator → enrich →
// registry` cycle from the wrong end and observes a half-initialised
// module (D-ADAPTER-HOME).  The adapter menu is now stub-free: jpa
// persistence, layered style, byLayer+byFeature layouts.
const javaPlatform = platformFor("java");

describe("java platform — registry resolution", () => {
  it("bareword `java` resolves to java@v1", () => {
    expect(parseBuiltinPlatformRef("java")).toEqual({
      family: "java",
      version: "v1",
      qualified: "java@v1",
    });
  });

  it("bareword and pinned form resolve to the same surface instance", () => {
    expect(platformFor("java")).toBe(platformFor("java@v1" as never));
    expect(platformFor("java")).toBe(javaPlatform);
  });

  it("rejects an unregistered java version", () => {
    expect(() => platformFor("java@v99" as never)).toThrow(
      /Unknown backend platform version "java@v99"/,
    );
  });
});

describe("java platform — surface shape", () => {
  it("is a dual-mode backend like dotnet", () => {
    expect(javaPlatform.name).toBe("java");
    expect(javaPlatform.needsDb).toBe(true);
    expect(javaPlatform.isFrontend).toBe(false);
    expect(javaPlatform.mountsUi).toBe(true);
    expect([...javaPlatform.hostableFrameworks].sort()).toEqual([
      "angular",
      "react",
      "static",
      "svelte",
      "vue",
    ]);
  });

  it("compose service is a Postgres-backed Spring service probing /ready", () => {
    const shape = javaPlatform.composeService({
      deployable: { name: "shopApi" } as never,
      sys: {} as never,
      slug: "shop_api",
    });
    expect(shape.dependsOnDb).toBe(true);
    expect(shape.healthPath).toBe("/ready");
    expect(shape.internalPort).toBe(8080);
    expect(shape.env).toContainEqual([
      "SPRING_DATASOURCE_URL",
      "jdbc:postgresql://db:5432/shop_api",
    ]);
  });
});

describe("java platform — adapter menu", () => {
  it("real adapters: jpa persistence, layered style, both layouts", () => {
    expect(availableAdapterNames("java", "persistence")).toEqual(["jpa"]);
    expect(availableAdapterNames("java", "style")).toEqual(["layered"]);
    expect(availableAdapterNames("java", "layout")).toEqual(["byFeature", "byLayer"]);
  });

  it("no reserved stubs remain — the full menu equals the real menu", () => {
    // The jooq / axon persistence stubs and the cqrs style stub were removed.
    expect(allAdapterNames("java", "persistence")).toEqual(["jpa"]);
    expect(allAdapterNames("java", "style")).toEqual(["layered"]);
  });

  it("defaults: jpa / layered / byFeature", () => {
    expect(defaultsFor("java")).toEqual({
      persistence: { state: "jpa", eventLog: "jpa" },
      style: "layered",
      layout: "byFeature",
    });
  });
});
