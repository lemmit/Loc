// Domain `test "..."` block — aggregate `create({...})` call emission.
//
// A `test` block that does `let p = Agg.create({...})` lowers to a plain
// `let` whose value is a `method-call` (member `create`) over an `object`
// literal.  Each backend's test-file emitter must render that as a real
// factory call, NOT pass the object literal straight through:
//
//   - TS:   `Agg.create({ ...provided })` — the factory's optional inputs
//           may be omitted (they default to null); required inputs the
//           source named must be present.  A bare object literal is already
//           the factory's argument shape, so this renders directly.
//   - .NET: `Agg.Create(name: ..., ..., <optional>: null)` — the positional
//           `Create(...)` factory takes *every* canonical create input as a
//           required parameter (no C# default), so a create that names only
//           a subset must fill each omitted input with its omission value
//           (optional → null) via named args.  Rendering the object literal
//           verbatim would emit `Create(new { ... })` — a single anonymous
//           object passed to a 9-arg method, which does not compile (the
//           regression this locks).
//
// The fixture's create omits the optional `description?`, so the .NET call
// must synthesise `description: null` while TS leaves it out.

import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../_helpers/index.js";

const FIXTURE = `
system Demo {
  subdomain Projects {
    context Catalog {
      aggregate Project with crudish {
        name: string
        description: string?
        budget: decimal
        invariant name.length > 0
        operation rename(newName: string) {
          precondition newName.length > 0
          name := newName
        }
        test "partial create omits the optional field" {
          let p = Project.create({ name: "demo", budget: 0.0 })
          expect(p.rename("")).toThrow()
        }
      }
      repository ProjectRepo for Project { }
    }
  }
  api ProjectsApi from Projects
  deployable honoApi   { platform: node   contexts: [Catalog] serves: ProjectsApi port: 3000 }
  deployable dotnetApi { platform: dotnet contexts: [Catalog] serves: ProjectsApi port: 8080 }
}
`;

function findFile(files: Map<string, string>, pattern: RegExp): string {
  for (const [k, v] of files) if (pattern.test(k)) return v;
  throw new Error(`no generated file matched ${pattern}`);
}

/** The create statement of the rendered test body (single line). */
function createLine(src: string, marker: RegExp): string {
  const line = src.split("\n").find((l) => marker.test(l));
  if (!line) throw new Error(`no create line matching ${marker} in:\n${src}`);
  return line.trim();
}

describe("domain test-block aggregate create — backend emission", () => {
  it(".NET renders a named-arg Create(...) filling the omitted optional with null", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const tests = findFile(files, /ProjectTests\.cs$/i);
    const line = createLine(tests, /Project\.Create\(/);
    // Named-arg factory call, not a `new { ... }` anonymous object.
    expect(line).not.toMatch(/Project\.Create\(new\s*\{/);
    // Provided inputs ride through; the omitted optional is filled with null.
    expect(line).toMatch(/name:\s*"demo"/);
    expect(line).toMatch(/budget:\s*0\.0m/);
    expect(line).toMatch(/description:\s*null/);
  });

  it("TS renders the object-literal create with the provided inputs", async () => {
    const files = await generateSystemFiles(FIXTURE);
    const tests = findFile(files, /project\.test\.ts$/i);
    const line = createLine(tests, /Project\.create\(/);
    // Object-literal factory argument (the TS factory's input shape), not a
    // C#-style anonymous object.
    expect(line).not.toMatch(/Project\.create\(new\s/);
    expect(line).toMatch(/name:\s*"demo"/);
    expect(line).toMatch(/budget:\s*0\.0/);
  });
});
