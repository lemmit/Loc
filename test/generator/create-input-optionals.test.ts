// Create-input contract regression — optionals are part of the create.
//
// `createInputFields` is the single source of truth every create surface
// (wire DTO, domain factory) derives from.  It returns the FULL
// client-suppliable set (`forCreateInput`: drops managed/token/internal,
// keeps immutable/secret) INCLUDING optional fields — equivalent to a
// crudish aggregate's `canonicalCreate.params`.  Optionality rides each
// field's own type nullability into every backend's optionality
// derivation, so an optional field (`description?`) appears in the create
// request but is NOT required, and the create factory accepts (and
// persists) it.  A regression to the old "required-only" create input
// would silently drop optionals from the create contract across every
// backend — this locks the full set in at both the IR and emitted-source
// levels.

import { describe, expect, it } from "vitest";
import { createInputFields } from "../../src/ir/enrich/wire-projection.js";
import { allAggregates } from "../../src/ir/types/loom-ir.js";
import { buildLoomModel, generateSystemFiles } from "../_helpers/index.js";

const FIXTURE = `
system Demo {
  subdomain Projects {
    context Catalog {
      aggregate Project ids guid with crudish {
        name: string
        description: string?
        externalId: guid?
        budget: decimal
      }
      repository ProjectRepo for Project { }
    }
  }
  api ProjectsApi from Projects
  deployable honoApi    { platform: hono            contexts: [Catalog] serves: ProjectsApi port: 3000 }
  deployable dotnetApi  { platform: dotnet          contexts: [Catalog] serves: ProjectsApi port: 8080 }
  deployable phoenixApi { platform: phoenix contexts: [Catalog] serves: ProjectsApi port: 4000 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string | undefined {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  return undefined;
}

/** Extract the `required: [...]` atom list from a rendered OpenApiSpex schema. */
function requiredAtoms(src: string): string[] {
  const m = src.match(/required:\s*\[([^\]]*)\]/);
  if (!m || !m[1]!.trim()) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim().replace(/^:/, ""))
    .filter(Boolean);
}

describe("create-input contract — optionals are included", () => {
  it("createInputFields returns the full set, optionals included", async () => {
    const loom = await buildLoomModel(FIXTURE);
    const project = allAggregates(loom).find((a) => a.name === "Project")!;
    const names = createInputFields(project).map((f) => f.name);
    // Required + optional client-suppliable fields all present.
    expect(names).toEqual(["name", "description", "externalId", "budget"]);
    // The optionals carry their optionality through (consumers derive
    // required-ness from this, not from membership).
    const byName = new Map(createInputFields(project).map((f) => [f.name, f]));
    expect(byName.get("description")!.optional).toBe(true);
    expect(byName.get("externalId")!.optional).toBe(true);
    expect(byName.get("name")!.optional).toBe(false);
    expect(byName.get("budget")!.optional).toBe(false);
  });

  it("Hono CreateRequest includes optionals as nullish, requires the rest", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const routes = findFile(files, /project\.routes\.ts$/i)!;
    const block = routes.match(/const CreateProjectRequest = z\.object\(\{[\s\S]*?\}\)/)![0];
    expect(block).toMatch(/name:\s*z\.string\(\),/);
    expect(block).toMatch(/description:\s*z\.string\(\)\.nullish\(\)/);
    expect(block).toMatch(/externalId:\s*z\.string\(\)\.nullish\(\)/);
  });

  it("Hono create factory accepts the optional fields", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const domain = findFile(files, /domain\/project\.ts$/i)!;
    expect(domain).toMatch(/static create\(input: \{[^}]*description\?:/);
    expect(domain).toMatch(/static create\(input: \{[^}]*externalId\?:/);
  });

  it(".NET CreateRequest leaves optionals nullable (not [Required])", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const dto = findFile(files, /ProjectRequests\.cs$/i)!;
    const create = dto.match(/record CreateProjectRequest\([^;]*\);/)![0];
    // Required scalar carries Required; optionals are bare nullable.  The
    // attribute target (`[Required]` on the record parameter vs
    // `[property: Required]` on the property) is an ASP.NET binding detail,
    // not part of "is it required" — so match either form.
    expect(create).toMatch(/\[(?:property: )?Required\][^,)]*\bName\b/);
    expect(create).toMatch(/string\?\s+Description/);
    expect(create).not.toMatch(/\[(?:property: )?Required\][^,)]*\bDescription\b/);
  });

  it("Phoenix CreateProjectRequest marks optionals not-required", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const req = findFile(files, /create_project_request\.ex$|CreateProjectRequest\.ex$/i)!;
    const required = requiredAtoms(req);
    expect(required).toContain("name");
    expect(required).toContain("budget");
    expect(required).not.toContain("description");
    expect(required).not.toContain("external_id");
    expect(required).not.toContain("externalId");
  });
});
