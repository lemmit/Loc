// byLayer — real LayoutAdapter for hono (F6c).  Mirrors
// dotnet-by-layer.test.ts.  Pins every category to the exact path the
// existing TypeScript/Hono emitter writes today.  Verified against
// `generate ts examples/sales.ddd`: every emitted file is reproducible.

import { describe, expect, it } from "vitest";
import type { EmitCtx } from "../../src/generator/_adapters/index.js";
import {
  byLayerLayoutAdapter,
  type HonoArtifact,
} from "../../src/platform/hono/v4/adapters/by-layer-layout.js";
import { resolveLayout } from "../../src/platform/resolve-adapters.js";

const ctx = {} as EmitCtx;

function p(
  a: Partial<HonoArtifact> & { name: string; category: HonoArtifact["category"] },
): string {
  return byLayerLayoutAdapter.pathFor({ content: "", ...a } as HonoArtifact, ctx);
}

describe("byLayer LayoutAdapter — hono (real)", () => {
  it("is registered as the hono byLayer layout adapter", () => {
    const resolved = resolveLayout("node", "byLayer");
    expect(resolved).toBe(byLayerLayoutAdapter);
    expect(resolved.name).toBe("byLayer");
  });

  it("places per-aggregate domain modules under domain/<lowerFirst>.ts", () => {
    expect(p({ name: "x", category: "domain-aggregate", aggregateName: "Order" })).toBe(
      "domain/order.ts",
    );
    // lowerFirst only lowercases the first char — multi-word aggregates
    // remain camelCase (no kebab).
    expect(p({ name: "x", category: "domain-aggregate", aggregateName: "OrderLine" })).toBe(
      "domain/orderLine.ts",
    );
  });

  it("routes the per-aggregate extern base + test files into domain/", () => {
    expect(p({ name: "x", category: "domain-aggregate-base", aggregateName: "Order" })).toBe(
      "domain/order.base.ts",
    );
    expect(p({ name: "x", category: "domain-test", aggregateName: "Order" })).toBe(
      "domain/order.test.ts",
    );
  });

  it("places pooled domain files at their fixed paths", () => {
    expect(p({ name: "x", category: "domain-ids" })).toBe("domain/ids.ts");
    expect(p({ name: "x", category: "domain-value-objects" })).toBe("domain/value-objects.ts");
    expect(p({ name: "x", category: "domain-events" })).toBe("domain/events.ts");
    expect(p({ name: "x", category: "domain-errors" })).toBe("domain/errors.ts");
    expect(p({ name: "x", category: "domain-provenance" })).toBe("domain/provenance.ts");
  });

  it("routes db/ files for schema, per-aggregate repos, and migrations", () => {
    expect(p({ name: "x", category: "drizzle-schema" })).toBe("db/schema.ts");
    expect(p({ name: "x", category: "drizzle-repository", aggregateName: "Order" })).toBe(
      "db/repositories/order-repository.ts",
    );
    expect(p({ name: "0001_init.sql", category: "migration" })).toBe("db/migrations/0001_init.sql");
    expect(p({ name: "meta/_journal.json", category: "migration" })).toBe(
      "db/migrations/meta/_journal.json",
    );
  });

  it("routes http/ files for index + per-aggregate routes + views/workflows", () => {
    expect(p({ name: "x", category: "http-index" })).toBe("http/index.ts");
    expect(p({ name: "x", category: "http-routes", aggregateName: "Order" })).toBe(
      "http/order.routes.ts",
    );
    expect(p({ name: "x", category: "http-views" })).toBe("http/views.ts");
    expect(p({ name: "x", category: "http-workflows" })).toBe("http/workflows.ts");
  });

  it("routes auth/ files when the deployable opts in", () => {
    expect(p({ name: "x", category: "auth-user-types" })).toBe("auth/user-types.ts");
    expect(p({ name: "x", category: "auth-verifier" })).toBe("auth/verifier.ts");
    expect(p({ name: "x", category: "auth-middleware" })).toBe("auth/middleware.ts");
  });

  it("routes obs/ observability plumbing files", () => {
    expect(p({ name: "x", category: "obs-log" })).toBe("obs/log.ts");
    expect(p({ name: "x", category: "obs-als" })).toBe("obs/als.ts");
    expect(p({ name: "x", category: "obs-request-id" })).toBe("obs/request-id.ts");
  });

  it("places lib/ helper modules under lib/", () => {
    expect(p({ name: "x", category: "lib-schemas" })).toBe("lib/schemas.ts");
  });

  it("routes top-level project files to the root", () => {
    expect(p({ name: "x", category: "project-index" })).toBe("index.ts");
    expect(p({ name: "x", category: "package-json" })).toBe("package.json");
    expect(p({ name: "x", category: "tsconfig" })).toBe("tsconfig.json");
    expect(p({ name: "x", category: "tsup-config" })).toBe("tsup.config.ts");
    expect(p({ name: "x", category: "drizzle-config" })).toBe("drizzle.config.ts");
    expect(p({ name: "x", category: "dockerfile" })).toBe("Dockerfile");
    expect(p({ name: "x", category: "dockerignore" })).toBe(".dockerignore");
    expect(p({ name: "x", category: "license" })).toBe("LICENSE");
  });

  it("places certs/ entries under certs/<name>", () => {
    expect(p({ name: ".gitkeep", category: "certs-marker" })).toBe("certs/.gitkeep");
  });

  it("throws a clear error when a per-aggregate category lacks aggregateName", () => {
    expect(() => p({ name: "x", category: "domain-aggregate" })).toThrow(/missing aggregateName/);
    expect(() => p({ name: "x", category: "drizzle-repository" })).toThrow(/missing aggregateName/);
    expect(() => p({ name: "x", category: "http-routes" })).toThrow(/missing aggregateName/);
  });

  it("throws when an artifact arrives without a category tag", () => {
    expect(() => byLayerLayoutAdapter.pathFor({ name: "X.ts", content: "" }, ctx)).toThrow(
      /missing a category/,
    );
  });
});
