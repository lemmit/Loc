// Phoenix extern frontend function (extern-function-hook-escape-hatch.md):
// a `function f(…): T extern from "<path>"` ui member renders as a
// FULLY-QUALIFIED call into the user's hand-written Elixir module (derived from
// the `from` path) — Elixir resolves a fully-qualified call without an import,
// so no wiring is needed and a missing module fails `mix compile` (the
// fail-fast, matching the JSX frontends' conformance shim).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";

const SOURCE = `system MiniLiveView {
  subdomain Sales {
    context Sales {
      aggregate Customer { name: string }
      repository Customers for Customer { }
    }
  }
  api SalesApi from Sales
  ui SalesAdmin {
    function initials(name: string): string extern from "helpers/format"
    page Home { route: "/" body: Heading { initials("Ada Lovelace") } }
  }
  deployable phoenixApp {
    platform: elixir, contexts: [Sales], serves: SalesApi, ui: SalesAdmin, port: 4000
  }
}
`;

async function build(): Promise<Map<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-pexternfn-"));
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

describe("Phoenix extern frontend function", () => {
  it("renders a body call fully-qualified into the module derived from the path", async () => {
    const files = await build();
    const live = files.get("phoenix_app/lib/phoenix_app_web/live/home_live.ex")!;
    expect(live, "home_live.ex is generated").toBeDefined();
    // `from "helpers/format"` → `Helpers.Format`; the call is fully-qualified so
    // no `import` is needed.
    expect(live).toContain('Helpers.Format.initials("Ada Lovelace")');
    expect(live).not.toMatch(/import Helpers\.Format/);
  });
});
