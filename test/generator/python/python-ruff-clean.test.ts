import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseString } from "../../_helpers/index.js";

// The generated FastAPI project is gated by `ruff check` (python-build.yml).
// These pin three shapes that emitted ruff-failing code, reproduced from the
// showcase example (not in the python-build fixture set, so CI never saw them):
//   E713  a `.contains(...)` membership guard → `not in`, not `not (x in y)`
//   F841  an unused workflow `let` over a `run` retrieval → bare `await`
//   F401  seed.py imported `datetime.UTC` but never used it

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOWCASE = fs.readFileSync(path.resolve(here, "../../../examples/showcase.ddd"), "utf8");

async function build(): Promise<Map<string, string>> {
  const { model, errors } = await parseString(SHOWCASE);
  if (errors.length) throw new Error(`showcase has validation errors:\n${errors.join("\n")}`);
  return generateSystems(model).files;
}

function fileEndingWith(files: Map<string, string>, suffix: string): string {
  for (const [k, v] of files) if (k.endsWith(suffix)) return v;
  throw new Error(`no generated file ending with ${suffix}`);
}

describe("python generator — ruff-clean output", () => {
  it("E713: a contains membership guard emits `not in`, not `not (x in y)`", async () => {
    const routes = fileEndingWith(await build(), "app/http/workflows_routes.py");
    expect(routes).toContain('"projects.manageProjects" not in current_user.permissions');
    expect(routes).not.toContain('not ("projects.manageProjects" in current_user.permissions)');
  });

  it("F841: an unused `run` retrieval let drops the assignment, keeping the await", async () => {
    const routes = fileEndingWith(await build(), "app/http/workflows_routes.py");
    expect(routes).toContain(
      "await projects.run_find_all_by_active_named_by_sequence_desc(needle)",
    );
    expect(routes).not.toContain(
      "adhoc = await projects.run_find_all_by_active_named_by_sequence_desc(needle)",
    );
  });

  it("F401: seed.py imports datetime without the unused UTC", async () => {
    const seed = fileEndingWith(await build(), "app/db/seed.py");
    expect(seed).toContain("from datetime import datetime");
    expect(seed).not.toContain("from datetime import UTC, datetime");
  });
});
