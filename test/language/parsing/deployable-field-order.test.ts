import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Deployable, Model, System } from "../../../src/language/generated/ast.js";

// The `deployable { … }` clauses (contexts / dataSources / targets / serves /
// ui / hosts / port / auth / design / favicon) are ORDER-INDEPENDENT: each is
// introduced by a distinct keyword, so they parse in any order. This pins that
// — a regression to the old fixed-order sequence would fail here.

async function parse(src: string): Promise<{ model: Model; errors: string[] }> {
  const { parseHelper } = await import("langium/test");
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
  return { model: doc.parseResult.value as Model, errors };
}

function deployables(model: Model): Deployable[] {
  const sys = model.members.find((m): m is System => m.$type === "System");
  return (sys?.members ?? []).filter((m): m is Deployable => m.$type === "Deployable");
}

describe("deployable field order-independence", () => {
  it("parses deployable clauses in a scrambled order", async () => {
    const { model, errors } = await parse(`
      system S {
        subdomain Core { context C {
          aggregate Thing with crudish { title: string }
          repository Things for Thing { }
        } }
        ui WebApp with scaffold(subdomains: [Core]) { }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }

        deployable web {
          platform: react,
          design: shadcn,
          port: 3001,
          ui: WebApp,
          targets: api
        }
        deployable api {
          platform: node,
          port: 3000,
          dataSources: [cState],
          contexts: [C]
        }
      }
    `);

    expect(errors).toEqual([]);

    const byName = Object.fromEntries(deployables(model).map((d) => [d.name, d]));

    // Frontend: design/port/ui/targets all landed despite design-before-port.
    expect(byName.web?.platform).toBe("react");
    expect(byName.web?.design).toBe("shadcn");
    expect(byName.web?.port).toBe(3001);
    expect(byName.web?.targets?.$refText).toBe("api");

    // Backend: dataSources-before-contexts is accepted and both bind.
    expect(byName.api?.platform).toBe("node");
    expect(byName.api?.port).toBe(3000);
    expect(byName.api?.contextRefs.map((r) => r.$refText)).toEqual(["C"]);
    expect(byName.api?.dataSourceRefs.map((r) => r.$refText)).toEqual(["cState"]);
  });

  it("still parses the canonical order the printer emits", async () => {
    const { errors } = await parse(`
      system S {
        subdomain Core { context C {
          aggregate Thing with crudish { title: string }
          repository Things for Thing { }
        } }
        ui WebApp with scaffold(subdomains: [Core]) { }
        storage primary { type: postgres }
        resource cState { for: C, kind: state, use: primary }

        deployable api {
          platform: node,
          contexts: [C],
          dataSources: [cState],
          port: 3000
        }
        deployable web {
          platform: react,
          targets: api,
          ui: WebApp,
          port: 3001,
          design: mantine
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});
