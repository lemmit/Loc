import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel, mergeLoomModels } from "../../src/ir/lower/lower.js";
import type { LoomDiagnostic } from "../../src/ir/validate/validate.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { Model } from "../../src/language/generated/ast.js";
import { loadProject } from "../../src/language/project-loader.js";

function writeProject(rootDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

async function validateProject(entryDdd: string): Promise<LoomDiagnostic[]> {
  const services = createDddServices(NodeFileSystem);
  const { all } = await loadProject(URI.file(entryDdd), services.shared);
  const merged = mergeLoomModels(all.map((d) => lowerModel(d.parseResult.value as Model)));
  const loom = enrichLoomModel(merged);
  return validateLoomModel(loom);
}

describe("workspace-uniqueness validation (multi-file)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-mf-validate-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects duplicate root-level valueobjects across files", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./a.ddd"
        import "./b.ddd"
        context Z { }
      `,
      "a.ddd": `valueobject Money { amount: decimal }`,
      "b.ddd": `valueobject Money { amount: decimal }`,
    });
    const diags = await validateProject(path.join(tmp, "main.ddd"));
    const errors = diags.filter((d) => d.severity === "error");
    expect(
      errors.some((e) => e.message.includes("duplicate root-level value object 'Money'")),
    ).toBe(true);
  });

  it("rejects duplicate root-level enums across files", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./a.ddd"
        import "./b.ddd"
        context Z { }
      `,
      "a.ddd": `enum Currency { USD, EUR }`,
      "b.ddd": `enum Currency { USD, JPY }`,
    });
    const diags = await validateProject(path.join(tmp, "main.ddd"));
    expect(
      diags.some(
        (d) => d.severity === "error" && d.message.includes("duplicate root-level enum 'Currency'"),
      ),
    ).toBe(true);
  });

  it("rejects two contexts of the same name across files", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./a.ddd"
        import "./b.ddd"
      `,
      "a.ddd": `context Sales { }`,
      "b.ddd": `context Sales { }`,
    });
    const diags = await validateProject(path.join(tmp, "main.ddd"));
    expect(
      diags.some((d) => d.severity === "error" && d.message.includes("duplicate context 'Sales'")),
    ).toBe(true);
  });

  it("rejects two systems of the same name across files", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./a.ddd"
        import "./b.ddd"
      `,
      "a.ddd": `system Shop {
        subdomain M { }
        deployable api { platform: hono, contexts: [C] }
      }`,
      "b.ddd": `system Shop {
        subdomain M2 { }
        deployable api2 { platform: hono, contexts: [M2] }
      }`,
    });
    const diags = await validateProject(path.join(tmp, "main.ddd"));
    expect(
      diags.some((d) => d.severity === "error" && d.message.includes("duplicate system 'Shop'")),
    ).toBe(true);
  });

  it("rejects a context-local VO that shadows a root-level one", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./shared.ddd"
        import "./sales.ddd"
      `,
      "shared.ddd": `valueobject Money { amount: decimal }`,
      "sales.ddd": `
        context Sales {
          valueobject Money { amount: decimal, currency: string }
        }
      `,
    });
    const diags = await validateProject(path.join(tmp, "main.ddd"));
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          d.message.includes("declares value object 'Money' that shadows the root-level"),
      ),
    ).toBe(true);
  });

  it("accepts a clean multi-file project", async () => {
    writeProject(tmp, {
      "main.ddd": `
        import "./shared.ddd"
        import "./sales.ddd"
        system Shop {
          subdomain M { }
          deployable api { platform: hono, contexts: [C] }
        }
      `,
      "shared.ddd": `
        valueobject Money { amount: decimal, currency: string }
        enum Currency { USD, EUR }
      `,
      "sales.ddd": `
        context Sales {
          aggregate Order {
            total: Money
            currency: Currency
          }
        }
      `,
    });
    const diags = await validateProject(path.join(tmp, "main.ddd"));
    expect(diags.filter((d) => d.severity === "error")).toEqual([]);
  });
});
