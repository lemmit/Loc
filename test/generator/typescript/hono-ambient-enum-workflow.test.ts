// Regression: a bare reference to a ROOT-LEVEL (ambient) enum value
// inside a workflow body must resolve to the qualified runtime const.
//
// Root-level `enum X { … }` declared outside any context is an ambient
// shared kernel.  A workflow that constructs an aggregate with such an
// enum value (`Task.create({ priority: Normal })`) references the value by
// bare name.  Enrichment folds root enums into each context, but that runs
// AFTER lowering, and in a multi-file project the enum lives in a sibling
// document — so lowering's context-local enum scan never saw it and the
// value lowered to an unresolved ref, rendering as a bare, undefined
// `Normal` (TS2304 "Cannot find name 'Normal'", a bundle/runtime error).
// `lowerProject` now indexes the project-global ambient enums so the value
// resolves to `Priority.Normal` and the enum is imported.

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  enum Priority { Low, Normal, High }

  system Sys {
    subdomain Ops {
      context Ops {
        aggregate Task {
          title: string
          priority: Priority
        }
        repository Tasks for Task {}
        workflow makeTask transactional {
          create(title: string) {
            let t = Task.create({ title: title, priority: Normal })
          }
        }
      }
    }
    storage primary { type: postgres }
    deployable api {
      platform: node
      contexts: [Ops]
      port: 3000
    }
  }
`;

async function workflowsFile(): Promise<string> {
  const files = (await generateSystems(await parseValid(SRC))).files;
  const path = [...files.keys()].find((k) => k.endsWith("/http/workflows.ts"));
  expect(path, "workflows.ts not emitted").toBeDefined();
  return files.get(path!)!;
}

describe("Hono workflow — ambient root-enum value resolves qualified", () => {
  it("renders the kernel enum value as Enum.Value and imports the enum", async () => {
    const wf = await workflowsFile();
    expect(wf).toContain("priority: Priority.Normal");
    expect(wf).not.toMatch(/priority:\s*Normal\b/);
    // The enum const must be imported (it's referenced as a runtime value).
    expect(wf).toMatch(
      /import\s*\{[^}]*\bPriority\b[^}]*\}\s*from\s*"\.\.\/domain\/value-objects"/,
    );
  });
});
