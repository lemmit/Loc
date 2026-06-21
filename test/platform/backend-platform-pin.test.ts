import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";

// ---------------------------------------------------------------------------
// The grammar admits `platform: "node@v4"`
// (STRING alternative).  Lowering normalises it to the family
// (byte-identical `platform`) + a qualified `platformRef`; the
// validator rejects unknown versions / unknown platforms.  The legacy
// `hono` / `hono@v4` spellings were retired (D-NODE-PLATFORM) — they now
// fail validation like any other unknown platform.  See
// docs/backend-packages.md.
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
    deployable api { platform: ${platform}, contexts: [C], port: 3000 }
  }
`;

describe("platform pin grammar + validation", () => {
  it("accepts a bareword backend platform", async () => {
    const { errors } = await parse(sys("node"));
    expect(errors).toEqual([]);
  });

  it('accepts a registered pin `platform: "node@v4"`', async () => {
    const { errors } = await parse(sys(`"node@v4"`));
    expect(errors).toEqual([]);
  });

  it("rejects the retired `hono` alias (D-NODE-PLATFORM)", async () => {
    const { errors } = await parse(sys(`"hono"`));
    expect(errors.some((e) => /Unknown platform 'hono'/.test(e))).toBe(true);
    const pinned = await parse(sys(`"hono@v4"`));
    expect(pinned.errors.some((e) => /Unknown platform 'hono@v4'/.test(e))).toBe(true);
  });

  it("rejects the retired `phoenix` / `phoenixLiveView` aliases (D-ELIXIR-PLATFORM)", async () => {
    const { errors } = await parse(sys(`"phoenix"`));
    expect(errors.some((e) => /Unknown platform 'phoenix'/.test(e))).toBe(true);
    const lv = await parse(sys(`"phoenixLiveView"`));
    expect(lv.errors.some((e) => /Unknown platform 'phoenixLiveView'/.test(e))).toBe(true);
  });

  it("rejects an unregistered version with an available-list error", async () => {
    const { errors } = await parse(sys(`"node@v9"`));
    expect(errors.some((e) => /no version 'v9' of backend 'node'/.test(e))).toBe(true);
    expect(errors.some((e) => /'node@v4'/.test(e))).toBe(true);
  });

  it("rejects an unknown platform name (STRING no longer a free pass)", async () => {
    const { errors } = await parse(sys(`"frobnicator"`));
    expect(errors.some((e) => /Unknown platform 'frobnicator'/.test(e))).toBe(true);
  });

  it("still accepts a quoted frontend keyword", async () => {
    const { errors } = await parse(`
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: "static", targets: api, ui: W, port: 3001 }
      }
    `);
    expect(errors).toEqual([]);
  });
});

describe("lowering normalises platform + platformRef", () => {
  async function lowerDeployable(platform: string) {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(sys(platform), {
      validation: false,
    });
    const loom = lowerModel(doc.parseResult.value as Model);
    return loom.systems[0]!.deployables[0]!;
  }

  it("bareword: platform=family, platformRef=family@latest", async () => {
    const d = await lowerDeployable("node");
    expect(d.platform).toBe("node"); // byte-identical union value
    expect(d.platformRef).toBe("node@v5");
  });

  it("pin: platform=family (NOT the pin), platformRef=the pin", async () => {
    const d = await lowerDeployable(`"node@v4"`);
    // The pin's family lands on `platform`; the pin is carried
    // separately on platformRef.
    expect(d.platform).toBe("node");
    expect(d.platformRef).toBe("node@v4");
  });

  it("frontend: platform and platformRef both the bareword", async () => {
    const services = createDddServices(NodeFileSystem);
    const doc = await parseHelper(services.Ddd)(
      `
      system S {
        subdomain M { context C { } }
        ui W { page Home() { route: "/" body: Heading { "hi" } } }
        deployable api { platform: node, contexts: [C], port: 3000 }
        deployable web { platform: static, targets: api, ui: W, port: 3001 }
      }
    `,
      { validation: false },
    );
    const loom = lowerModel(doc.parseResult.value as Model);
    const web = loom.systems[0]!.deployables.find((x) => x.name === "web")!;
    expect(web.platform).toBe("static");
    expect(web.platformRef).toBe("static");
  });
});
