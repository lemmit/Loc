import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { parseBuiltinPlatformRef, platformFor } from "../../src/platform/registry.js";

// ---------------------------------------------------------------------------
// The `python` platform (FastAPI + SQLAlchemy 2 backend) — wiring slice.
//
// `python` is the canonical language-ecosystem platform name.  The
// `fastapi` framework-spelled platform alias was RETIRED (mirroring the
// retired `hono` → `node` and `phoenix` → `elixir` aliases): `python` is
// the only spelling.  See docs/old/plans/python-backend-plan.md (S1).
// ---------------------------------------------------------------------------

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const doc = await parseHelper(services.Ddd)(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    model: doc.parseResult.value as Model,
  };
}

const sys = (platform: string) => `
  system S {
    subdomain M { context C { } }
    deployable api { platform: ${platform}, contexts: [C], port: 8000 }
  }
`;

describe("python platform — registry resolution", () => {
  it("bareword `python` resolves to python@v1", () => {
    expect(parseBuiltinPlatformRef("python")).toEqual({
      family: "python",
      version: "v1",
      qualified: "python@v1",
    });
  });

  it("rejects the retired `fastapi` platform alias (now an unknown name)", () => {
    // The `fastapi` → `python` alias was retired, mirroring the retired
    // `hono` → `node` and `phoenix` → `elixir` aliases: `python` is the
    // only spelling.
    expect(parseBuiltinPlatformRef("fastapi")).toBeNull();
    expect(parseBuiltinPlatformRef("fastapi@v1")).toBeNull();
  });

  it("every spelling resolves to the SAME surface instance", () => {
    expect(platformFor("python")).toBe(platformFor("python@v1" as never));
  });

  it("throws a clear error for an unregistered python version", () => {
    expect(() => platformFor("python@v9" as never)).toThrow(
      /Unknown backend platform version "python@v9"/,
    );
  });

  it("surface flags: dual-mode backend (UI mount optional), owns a DB", () => {
    const surface = platformFor("python");
    expect(surface.name).toBe("python");
    expect(surface.defaultPort).toBe(8000);
    expect(surface.needsDb).toBe(true);
    // Dual-mode like dotnet (S18): `ui:` embeds a React SPA; without
    // one the deployable stays backend-only.
    expect(surface.mountsUi).toBe(true);
    expect(surface.isFrontend).toBe(false);
  });

  it("compose stanza: asyncpg DSN, db dependency, /ready healthcheck", () => {
    const shape = platformFor("python").composeService({
      deployable: { name: "api" } as never,
      sys: { name: "S" } as never,
      slug: "s_api",
    });
    expect(shape).toEqual({
      env: [
        ["DATABASE_URL", "postgresql+asyncpg://postgres:postgres@db:5432/s_api"],
        ["LOG_LEVEL", "info"],
      ],
      dependsOnDb: true,
      healthPath: "/ready",
      internalPort: 8000,
    });
  });
});

describe("python platform — grammar + validation", () => {
  it("accepts a bareword `platform: python`", async () => {
    const { errors } = await parse(sys("python"));
    expect(errors).toEqual([]);
  });

  it("rejects the retired `platform: fastapi` alias as an unknown platform", async () => {
    const { errors } = await parse(sys(`"fastapi"`));
    expect(errors.some((e) => /Unknown platform 'fastapi'/.test(e))).toBe(true);
  });

  it('accepts a registered pin `platform: "python@v1"`', async () => {
    const { errors } = await parse(sys(`"python@v1"`));
    expect(errors).toEqual([]);
  });

  it("rejects an unregistered version with an available-list error", async () => {
    const { errors } = await parse(sys(`"python@v9"`));
    expect(errors.some((e) => /no version 'v9' of backend 'python'/.test(e))).toBe(true);
    expect(errors.some((e) => /'python@v1'/.test(e))).toBe(true);
  });

  it("accepts a `ui:` binding (fullstack embed, S18)", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: python, contexts: [C], ui: W, port: 8000 }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("python platform — lowering normalisation", () => {
  async function lowerDeployable(platform: string) {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(sys(platform), {
      validation: false,
    });
    const loom = lowerModel(doc.parseResult.value as Model);
    return loom.systems[0]!.deployables[0]!;
  }

  it("bareword: platform=python, platformRef=python@v1", async () => {
    const d = await lowerDeployable("python");
    expect(d.platform).toBe("python");
    expect(d.platformRef).toBe("python@v1");
  });

  it("defaults the port to 8000 when omitted", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(
      `
      system S {
        subdomain M { context C { } }
        deployable api { platform: python, contexts: [C] }
      }
    `,
      { validation: false },
    );
    const loom = lowerModel(doc.parseResult.value as Model);
    expect(loom.systems[0]!.deployables[0]!.port).toBe(8000);
  });
});
