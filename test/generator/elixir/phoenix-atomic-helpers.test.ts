// Phoenix `--warnings-as-errors` regressions surfaced by the showcase
// backend-build gate:
//
//  1. A domain `function` with no in-module caller must NOT be a private
//     `defp` — Elixir's --warnings-as-errors rejects an unused private
//     function.  We emit it as a public `def` (with `@doc false`).
//
//  2. An operation whose precondition lowers to the *function form*
//     (`validate fn changeset, _opts -> …`) is non-atomic in Ash 3.x, so the
//     action must carry `require_atomic? false` even when it has no `change
//     fn` body — otherwise Ash's "cannot be done atomically" warning is fatal
//     under --warnings-as-errors.  A built-in single-field validation stays
//     atomic and must NOT get the opt-out.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const SOURCE = `system MiniAtomic {
  subdomain Sales {
    context Sales {
      aggregate Project {
        name: string
        active: bool
        description: string?

        // Derived nil-check: must lower to is_nil/1, not \`!= nil\`.
        derived hasDescription: bool = description != null

        // \`isActive\` IS referenced (precondition below); \`badge\` is NOT.
        function isActive(): bool = active == true
        function badge(): string = !active ? "off" : "on"

        // Function-form precondition (calls a helper) → validate fn → the
        // action must opt out of atomic.
        operation sync() {
          precondition isActive()
        }

        // Built-in single-field precondition → atomic-safe, NO opt-out.
        operation rename(newName: string) {
          precondition newName.length > 0
        }

        // Function-form precondition that references the op ARGUMENT
        // (cross-field newName != name) → the validate fn must bind new_name
        // via Ash.Changeset.get_argument or it's an undefined var.
        operation relabel(newName: string) {
          precondition newName != name
        }
      }
      repository Projects for Project { }
    }
  }

  api SalesApi from Sales

  deployable phoenixApp {
    platform: elixir { foundation: ash }
    contexts: [Sales]
    serves: SalesApi
    port: 4000
  }
}
`;

async function build(): Promise<Map<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-patomic-"));
  const file = path.join(dir, "mini.ddd");
  fs.writeFileSync(file, SOURCE);
  const services = createDddServices(NodeFileSystem);
  const doc = await services.shared.workspace.LangiumDocuments.getOrCreateDocument(URI.file(file));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1);
  if (errors.length > 0) {
    throw new Error("Validation errors:\n" + errors.map((e) => `  ${e.message}`).join("\n"));
  }
  return generateSystems(doc.parseResult.value as Model).files;
}

describe("Phoenix --warnings-as-errors hardening", () => {
  it("emits domain helper functions as public `def`, never unused `defp`", async () => {
    const files = await build();
    const resource = files.get("phoenix_app/lib/phoenix_app/sales/project.ex")!;
    expect(resource).toMatch(/def is_active\(record\)/);
    expect(resource).toMatch(/def badge\(record\)/);
    expect(resource).not.toMatch(/defp (is_active|badge)\(/);
  });

  it("renders a nil comparison as is_nil/1, not `!= nil`", async () => {
    const files = await build();
    const resource = files.get("phoenix_app/lib/phoenix_app/sales/project.ex")!;
    expect(resource).toMatch(/not is_nil\(record\.description\)/);
    expect(resource).not.toMatch(/record\.description != nil/);
  });

  it("adds `require_atomic? false` to an action with a function-form validate", async () => {
    const files = await build();
    const resource = files.get("phoenix_app/lib/phoenix_app/sales/project.ex")!;
    // The `sync` action's precondition lowers to `validate fn …`.
    expect(resource).toMatch(/update :sync do\s*\n\s*require_atomic\? false/);
  });

  it("binds the op argument in a function-form precondition validate (get_argument)", async () => {
    const files = await build();
    const resource = files.get("phoenix_app/lib/phoenix_app/sales/project.ex")!;
    const relabel = resource.slice(
      resource.indexOf("update :relabel do"),
      resource.indexOf("update :relabel do") + 400,
    );
    // The validate fn references `new_name`, so it must bind it from the
    // changeset argument (and `record` for the `name` attribute).
    expect(relabel).toContain("new_name = Ash.Changeset.get_argument(changeset, :new_name)");
    expect(relabel).toContain("record = changeset.data");
    expect(relabel).toMatch(/if new_name != record\.name/);
  });

  it("leaves a built-in-validation-only action atomic (no opt-out)", async () => {
    const files = await build();
    const resource = files.get("phoenix_app/lib/phoenix_app/sales/project.ex")!;
    const renameBlock = resource.slice(
      resource.indexOf("update :rename do"),
      resource.indexOf("update :rename do") + 200,
    );
    expect(renameBlock).not.toMatch(/require_atomic\? false/);
  });
});
