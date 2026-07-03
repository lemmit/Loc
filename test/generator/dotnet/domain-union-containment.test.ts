// Domain union records for exception-less OPERATION returns whose success
// variant is a full aggregate WITH nested wire DTOs (a containment →
// `IReadOnlyList<PartResponse>`).  The variant fields are wire-typed (the
// controller copies them 1:1 into the Application union DTO), so the Domain
// file must import the host aggregate's Application Responses namespace or the
// nested DTO name doesn't resolve — CS0246, the `build-generated-dotnet`
// showcase failure surfaced by the `reserve` op (#1638).  A scalar-only union
// keeps Domain free of the Application using.

import { describe, expect, it } from "vitest";
import { generateDotnet } from "../../_helpers/generate.js";
import { parseValid } from "../../_helpers/parse.js";

const WITH_CONTAINMENT = `
  context Work {
    error ProjectNotFound { resource: string }
    aggregate Project ids guid {
      name: string
      contains pipelines: Pipeline[]
      entity Pipeline { label: string }
      operation reserve(): Project or ProjectNotFound {
        return ProjectNotFound { resource: name }
      }
    }
  }
`;

const SCALAR_ONLY = `
  context Work {
    error Stale { resource: string }
    aggregate Ticket ids guid {
      code: string
      operation touch(): string or Stale {
        return Stale { resource: code }
      }
    }
  }
`;

function find(map: Map<string, string>, suffix: string): string {
  const key = [...map.keys()].find((k) => k.endsWith(suffix));
  if (!key) throw new Error(`no file ending ${suffix}; have:\n${[...map.keys()].join("\n")}`);
  return map.get(key)!;
}

describe("dotnet generator — Domain union with nested wire DTOs", () => {
  it("imports the Application Responses namespace when a variant carries a containment DTO", async () => {
    const map = await generateDotnet(await parseValid(WITH_CONTAINMENT));
    const union = find(map, "Domain/Projects/ProjectOrProjectNotFound.cs");
    expect(union).toContain("IReadOnlyList<PipelineResponse> Pipelines");
    expect(union).toContain(".Application.Projects.Responses;");
  });

  it("keeps a scalar-only union free of the Application using", async () => {
    const map = await generateDotnet(await parseValid(SCALAR_ONLY));
    const union = find(map, "Domain/Tickets/stringOrStale.cs");
    expect(union).not.toContain(".Application.");
  });
});
