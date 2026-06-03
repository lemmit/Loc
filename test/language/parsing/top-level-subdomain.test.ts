import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../../src/ir/enrich/enrichments.js";
import { lowerProject } from "../../../src/ir/lower/lower.js";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { loadProject } from "../../../src/language/project-loader.js";
import { generateSystemsFromLoom } from "../../../src/system/index.js";

// Tier 1 of implicit-system-composition.md: a `subdomain` declared at the
// top level of a sibling `.ddd` file folds into the project's single
// `system { }` block — including the system's `user {}` threading, so a
// cross-file subdomain may reference `currentUser`.

function writeProject(rootDir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
}

function errorsOf(docs: { uri: URI; diagnostics?: { severity?: number; message: string }[] }[]) {
  return docs.flatMap((d) =>
    (d.diagnostics ?? [])
      .filter((x) => x.severity === 1)
      .map((x) => `${path.basename(d.uri.fsPath)}: ${x.message}`),
  );
}

describe("top-level subdomain composition", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "loom-compose-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("folds sibling-file subdomains into the single system and hosts them", async () => {
    writeProject(tmp, {
      // The system block holds only name + singletons + deployment; the
      // domain lives in sibling files.
      "project.ddd": `
        import "./sales.ddd"
        import "./hr.ddd"
        system Acme {
          user { id: string  role: string }
          storage primary { type: postgres }
          resource salesState  { for: Sales,  kind: state, use: primary }
          resource peopleState { for: People, kind: state, use: primary }
          deployable api {
            platform: hono
            contexts: [Sales, People]
            dataSources: [salesState, peopleState]
            port: 3000
            auth: required
          }
        }
      `,
      "sales.ddd": `
        subdomain Sales {
          context Sales {
            aggregate Customer with crudish {
              name: string
              invariant name.length > 0
              derived display: string = name
            }
            repository Customers for Customer { }
          }
        }
      `,
      // A second subdomain that references the system's user block from a
      // different file — proves cross-file `currentUser` threading.
      "hr.ddd": `
        subdomain People {
          context People {
            enum EmployeeStatus { Active, Terminated }
            aggregate Employee with crudish {
              name: string
              status: EmployeeStatus = Active
              invariant name.length > 0
              derived display: string = name
              operation terminate() {
                requires currentUser.role == "hr"
                precondition status != Terminated
                status := Terminated
              }
            }
            repository Employees for Employee { }
          }
        }
      `,
    });

    const services = createDddServices(NodeFileSystem);
    const { all } = await loadProject(URI.file(path.join(tmp, "project.ddd")), services.shared);

    // No parse / validation errors — in particular `currentUser.role` in
    // hr.ddd resolves against the user block in project.ddd.
    expect(errorsOf(all)).toEqual([]);

    const loom = enrichLoomModel(lowerProject(all.map((d) => d.parseResult.value as Model)));

    // Both top-level subdomains composed into the one system.
    expect(loom.systems).toHaveLength(1);
    const sub = loom.systems[0]!.subdomains.map((s) => s.name).sort();
    expect(sub).toEqual(["People", "Sales"]);

    // The deployable actually hosts both — their aggregate code is emitted.
    const { files } = generateSystemsFromLoom(loom);
    const paths = [...files.keys()].join("\n");
    expect(paths).toMatch(/customer/i);
    expect(paths).toMatch(/employee/i);
  });

  it("rejects a top-level subdomain when the project has no system", async () => {
    writeProject(tmp, {
      "project.ddd": `
        import "./sales.ddd"
        valueobject Money { amount: decimal  currency: string }
      `,
      "sales.ddd": `
        subdomain Sales {
          context Sales {
            aggregate Customer with crudish { name: string  derived display: string = name }
          }
        }
      `,
    });
    const services = createDddServices(NodeFileSystem);
    const { all } = await loadProject(URI.file(path.join(tmp, "project.ddd")), services.shared);
    const msgs = errorsOf(all);
    expect(
      msgs.some((m) => /top-level 'subdomain' composes into the project's single 'system'/.test(m)),
    ).toBe(true);
  });
});
