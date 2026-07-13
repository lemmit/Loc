// Regression tests for the .NET emitter bugs that broke `dotnet build
// /warnaserror` on the generated examples/showcase.ddd project (and with it
// the conformance-parity gate — a failed image build aborts `docker compose
// up`, so `compose ps -a` came back empty and the spec fetch ECONNREFUSED'd).
// Each test pins the emitted artifact at the generator-unit tier, the tier
// that would have caught the break without docker:
//
//   1. workflow `if let` — the retrieval repo must be DI-injected (CS0103).
//   2. workflow repo-let on a user-declared find — the emitted repository
//      method is the plain PascalCase name, no `Async` suffix (CS1061).
//   3. variant-`match` over a UNION-FIND binding — the repository returns the
//      optional twin (`Agg?`), so the match must render a null-check switch,
//      never the `<Union>_<Tag>` carrier patterns (CS0246: no such records
//      exist for finds).
//   4. seed rows — the `Create(...)` factory takes EVERY create-input
//      positionally, so omitted optionals must be filled (CS7036) and a
//      datetime string literal must parse to a UTC DateTime (CS1503).
//   5. create controller — an optional id-ref wire member is `Guid?`; the
//      null-forgiving `!` does not unwrap a nullable VALUE type, so the id
//      ctor arg needs `.Value` (CS1503).
//   6. AuditableInterceptor — a stamp value reaching THROUGH the principal
//      (`currentUser.role`) needs the ambient-principal local materialised
//      (CS0103: `currentUser` did not exist in the static interceptor).

import { describe, expect, it } from "vitest";
import { wireToCommandArgument } from "../../../src/generator/dotnet/dto-mapping.js";
import { renderAuditableInterceptor } from "../../../src/generator/dotnet/emit/auditable-interceptor.tpl.js";
import type { AggregateIR, EnrichedBoundedContextIR } from "../../../src/ir/types/loom-ir.js";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    subdomain Core {
      context Catalog {
        error ProjectNotFound { resource: string }

        criterion ActiveNamed(needle: string) of Project = this.active == true && this.name == needle

        aggregate Project with crudish {
          name: string
          description: string?
          active: bool
          parent: Project id?
          createdAt: datetime
          operation addTag(t: string) {
            precondition t.length > 0
          }
        }

        repository Projects for Project {
          find locate(name: string): Project or ProjectNotFound where this.name == name
        }

        workflow resolveProject {
          create(name: string) {
              let outcome = Projects.locate(name)
              let label = match outcome {
                  Project p => p.name,
                  ProjectNotFound => "not found"
              }
          }
        }

        workflow touchActive {
          create(needle: string) {
              if let p = Projects.find(ActiveNamed(needle)) {
                  p.addTag("found")
              } else {
                  precondition needle.length > 0
              }
          }
        }

        seed default {
          Project { name: "Alpha", active: true, createdAt: "2024-01-01T00:00:00Z" }
        }
      }
    }
    api A from Core
    deployable svc { platform: dotnet  contexts: [Catalog]  serves: A  port: 8080 }
  }
`;

async function build(): Promise<Map<string, string>> {
  return generateSystems(await parseValid(SRC)).files;
}

function find(files: Map<string, string>, suffix: string): string {
  const key = [...files.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending ${suffix}; have:\n${[...files.keys()].join("\n")}`);
  return files.get(key)!;
}

describe(".NET showcase compile regressions (conformance-parity breakers)", () => {
  it("workflow union-find repo-let calls the plain find name (no Async suffix)", async () => {
    const handler = find(await build(), "Application/Workflows/ResolveProjectHandler.cs");
    expect(handler).toContain(".Locate(command.Name, cancellationToken)");
    expect(handler).not.toContain("LocateAsync");
  });

  it("variant-match over a union-find binding renders a null-check, not carrier patterns", async () => {
    const handler = find(await build(), "Application/Workflows/ResolveProjectHandler.cs");
    // The repository returns the optional twin (`Project?`), so the two-arm
    // match reduces to a null-check ternary.
    expect(handler).toContain('outcome is not null ? outcome.Name : "not found"');
    // The `<Union>_<Tag>` carrier records are never emitted for finds.
    expect(handler).not.toContain("ProjectOrProjectNotFound_");
  });

  it("an if-let workflow injects the retrieval's repository", async () => {
    const handler = find(await build(), "Application/Workflows/TouchActiveHandler.cs");
    expect(handler).toContain("private readonly IProjectRepository _projects;");
    expect(handler).toContain("IProjectRepository projects");
  });

  it("seed rows fill omitted create-inputs and parse datetime literals", async () => {
    const seed = find(await build(), "Infrastructure/Persistence/Seed.cs");
    // Positional Create over ALL create-inputs (name, description?, active,
    // parent?, createdAt) — omitted optionals become null, the datetime
    // string literal parses to a UTC DateTime.
    expect(seed).toContain(
      'Project.Create(name: "Alpha", description: null, active: true, parent: null, createdAt: DateTime.Parse("2024-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal))',
    );
    expect(seed).toContain("using System.Globalization;");
  });

  it("maps a nullable id-ref property with an EF value conversion (boot-crash otherwise)", async () => {
    // `parent: Project id?` is CLR `ProjectId?` — without an explicit
    // conversion EF throws AT BOOT ("property could not be mapped because the
    // database provider does not support this type"), which kills the
    // container before it ever serves /openapi.json.
    const cfg = find(await build(), "Configurations/ProjectConfiguration.cs");
    expect(cfg).toContain(
      'builder.Property(x => x.Parent).HasConversion(v => v.HasValue ? v.Value.Value : (Guid?)null, v => v.HasValue ? (ProjectId?)new ProjectId(v.Value) : (ProjectId?)null).HasColumnName("parent");',
    );
  });

  it("a union-op Domain carrier imports the part-Response namespace (CS0246 otherwise)", async () => {
    // #1638's `reserve(): Project or ProjectNotFound` made the Domain union
    // carrier spell the aggregate variant's containments as `<Part>Response`
    // — an Application DTO the Domain namespace couldn't see.
    const src = SRC.replace(
      "operation addTag(t: string) {",
      `contains steps: Step[]
          operation reserve(): Project or ProjectNotFound {
            return ProjectNotFound { resource: name }
          }
          operation addTag(t: string) {`,
    ).replace(
      "aggregate Project with crudish {",
      "aggregate Project with crudish {\n          entity Step { label: string }",
    );
    const files = generateSystems(await parseValid(src)).files;
    const carrier = find(files, "Domain/Projects/ProjectOrProjectNotFound.cs");
    expect(carrier).toContain("using Svc.Application.Projects.Responses;");
  });

  it("the create controller unwraps an optional id-ref wire member with .Value", async () => {
    const ctrl = find(await build(), "Api/ProjectsController.cs");
    expect(ctrl).toContain(
      "(request.Parent is null ? null : new ProjectId(request.Parent!.Value))",
    );
    expect(ctrl).not.toContain("new ProjectId(request.Parent!)");
  });
});

describe(".NET wireToCommandArgument — nullable value-type wires", () => {
  it("unwraps an optional id ref with .Value (the `!` form leaves it Guid?)", () => {
    const ctx = { valueObjects: [] } as unknown as EnrichedBoundedContextIR;
    const out = wireToCommandArgument(
      "request.Parent",
      { kind: "optional", inner: { kind: "id", targetName: "Project" } },
      ctx,
    );
    expect(out).toBe("(request.Parent is null ? null : new ProjectId(request.Parent!.Value))");
  });
});

describe(".NET AuditableInterceptor — principal-member stamp values", () => {
  it("materialises the ambient currentUser local for a `currentUser.<member>` stamp", () => {
    const agg = {
      name: "Engineer",
      contextStamps: [
        {
          event: "create",
          assignments: [
            {
              field: "createdByRole",
              value: {
                kind: "member",
                member: "role",
                receiver: { kind: "ref", name: "currentUser", refKind: "current-user" },
                receiverType: { kind: "entity", name: "User" },
                memberType: { kind: "primitive", name: "string" },
              },
            },
          ],
        },
      ],
    } as unknown as AggregateIR;
    const out = renderAuditableInterceptor("Api", [agg], "Id");
    // The claim reads straight off the ambient RequestContext — no arm-local:
    // an unused `var currentUser` is CS0219 under /warnaserror.
    expect(out).not.toContain("var currentUser");
    expect(out).toContain(
      "ctx.Entry(e).Property(x => x.CreatedByRole).CurrentValue = RequestContext.Current!.CurrentUser!.Role;",
    );
    expect(out).toContain("using Api.Domain.Common;");
    expect(out).toContain("using Api.Auth;");
  });
});
