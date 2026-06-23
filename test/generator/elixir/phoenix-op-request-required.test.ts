// Phoenix OpenAPI op-request required-set regression.
//
// The crudish `update` operation carries one param per writable field,
// preserving each field's nullability.  The Phoenix op-request schema
// emitter must derive `required[]` from that nullability — a nullable
// param (`description?`) is NOT required — exactly like Hono's `zodFor`
// (`.nullish()` → optional).  Hardcoding every op param as required made
// Phoenix mark nullable update params required and tripped the
// cross-backend conformance gate's required-set dimension
// (UpdateProjectRequest: required-only-phoenix=[description,...]).

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/index.js";

const FIXTURE = `
system Demo {
  subdomain M {
    context Projects {
      aggregate Project with crudish {
        name: string
        description: string?
        externalId: guid?
        tags: string[]?
        budget: decimal
      }
      repository Projects for Project { }
    }
  }
  api ProjectsApi from Projects
  deployable phoenixApp {
    platform: elixir { foundation: ash }
    contexts: [Projects]
    serves: ProjectsApi
    port: 4000
  }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

/** Extract the `required: [...]` atom list from a rendered OpenApiSpex
 *  schema module. */
function requiredAtoms(src: string): string[] {
  const m = src.match(/required:\s*\[([^\]]*)\]/);
  if (!m || !m[1]!.trim()) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim().replace(/^:/, ""))
    .filter(Boolean);
}

describe("Phoenix generator — op-request required-set follows param nullability", () => {
  it("UpdateProjectRequest marks nullable update params optional, not required", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const req = findFile(
      files,
      /api\/schemas\/update_project_request\.ex$|UpdateProjectRequest\.ex$/i,
    );
    expect(req, "UpdateProjectRequest module should be emitted").toBeDefined();
    const required = requiredAtoms(req!);
    // Non-nullable scalar params stay required; nullable ones drop out.
    // (`budget` is a non-nullable decimal; `name` is non-nullable string.)
    expect(required).toContain("name");
    expect(required).toContain("budget");
    expect(required).not.toContain("description");
    expect(required).not.toContain("external_id");
    expect(required).not.toContain("tags");
  });
});
