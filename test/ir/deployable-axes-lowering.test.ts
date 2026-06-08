import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { defaultsFor } from "../../src/platform/resolve-adapters.js";

// ---------------------------------------------------------------------------
// D-REALIZATION-AXES lowering — an absent axis normalizes to the platform
// default (adapter-backed axes from the live adapter menu, greenfield axes
// from the per-platform table); a frontend carries no axes.  The lowered
// `application` is the resolved ADAPTER key (`serviceLayer` → `layered`).
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
    expect(d.foundation).toBe("vanilla");
    expect(d.application).toBe("cqrs");
    expect(d.persistence).toBe("efcore");
    expect(d.directoryLayout).toBe("byLayer");
    expect(d.transport).toBe("minimalApi");
    expect(d.runtime).toBe("transactional");
  });

  it("bare hono → layered/drizzle defaults", async () => {
    const d = await lowerDeployable("hono");
    expect(d.application).toBe("layered");
    expect(d.persistence).toBe("drizzle");
    expect(d.directoryLayout).toBe("byLayer");
    expect(d.transport).toBe("hono");
    expect(d.foundation).toBe("vanilla");
    expect(d.runtime).toBe("transactional");
  });

  it("bare phoenix → ash foundation + ashPostgres/byFeature (after canonicalization)", async () => {
    const d = await lowerDeployable("phoenix");
    expect(d.foundation).toBe("ash");
    expect(d.application).toBe("ash");
    expect(d.persistence).toBe("ashPostgres");
    expect(d.directoryLayout).toBe("byFeature");
    expect(d.transport).toBe("phoenixRouter");
    expect(d.runtime).toBe("transactional");
  });

  it("defaults are sourced from the adapter menu, not hardcoded literals", async () => {
    const d = await lowerDeployable("dotnet");
    const def = defaultsFor("dotnet")!;
    expect(d.application).toBe(def.style);
    expect(d.persistence).toBe(def.persistence.state);
    expect(d.directoryLayout).toBe(def.layout);
  });

  it("an explicit axis overrides the default; the rest stay default", async () => {
    const d = await lowerDeployable("dotnet { application: cqrs }");
    expect(d.application).toBe("cqrs");
    expect(d.persistence).toBe("efcore");
    expect(d.directoryLayout).toBe("byLayer");
  });

  it("explicit `application: serviceLayer` lowers to the adapter key `layered`", async () => {
    const d = await lowerDeployable("hono { application: serviceLayer }");
    expect(d.application).toBe("layered");
  });

  it("a frontend deployable carries no realization axes", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(
      `
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: hono, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: W, port: 3001 }
      }
    `,
      { validation: false },
    );
    const loom = lowerModel(doc.parseResult.value as Model);
    const web = loom.systems[0]!.deployables.find((x) => x.name === "web")!;
    expect(web.foundation).toBeUndefined();
    expect(web.application).toBeUndefined();
    expect(web.persistence).toBeUndefined();
    expect(web.directoryLayout).toBeUndefined();
    expect(web.transport).toBeUndefined();
    expect(web.runtime).toBeUndefined();
  });

  // P1 of proposals/vanilla-phoenix-foundation.md — the menu admits
  // `foundation: vanilla` on phoenix, so an explicit value lowers cleanly
  // (the validator's R5 gates emission separately; lowering must not crash
  // or drop the value).
  it("explicit `foundation: vanilla` on phoenix is carried through to DeployableIR", async () => {
    const d = await lowerDeployable("phoenix { foundation: vanilla }");
    expect(d.foundation).toBe("vanilla");
    // The other axes default normally.
    expect(d.persistence).toBe("ashPostgres");
    expect(d.transport).toBe("phoenixRouter");
    expect(d.runtime).toBe("transactional");
  });
});
