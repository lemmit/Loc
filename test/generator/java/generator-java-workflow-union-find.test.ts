// Regression tests for the Java emitter bugs that broke `gradle bootJar` on
// the generated examples/showcase.ddd project (and with it the
// conformance-parity gate — a failed image build aborts `docker compose up`).
//
//   1. variant-`match` over a UNION-FIND binding — the repository returns the
//      bare success aggregate (null on absence) and no `<Union>_<Tag>` carrier
//      records exist for finds, so the match must render `case null` + a total
//      type pattern ("cannot find symbol" otherwise).
//   2. seed rows — a datetime string literal must parse to an `Instant`
//      ("String cannot be converted to Instant" otherwise).

import { describe, expect, it } from "vitest";
import { generateSystems } from "../../../src/system/index.js";
import { parseValid } from "../../_helpers/parse.js";

const SRC = `
  system S {
    subdomain Core {
      context Catalog {
        error ProjectNotFound { resource: string }

        aggregate Project {
          name: string
          description: string?
          active: bool
          createdAt: datetime
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

        seed default {
          Project { name: "Alpha", active: true, createdAt: "2024-01-01T00:00:00Z" }
        }
      }
    }
    api A from Core
    deployable svc { platform: java  contexts: [Catalog]  serves: A  port: 8081 }
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

describe("java workflow union-find (conformance-parity compile regressions)", () => {
  it("variant-match over a union-find binding renders case null + a total type pattern", async () => {
    const wf = find(await build(), "application/workflows/CatalogWorkflows.java");
    expect(wf).toContain('case null -> "not found";');
    expect(wf).toContain("case Project p -> outcome.name();");
    // The `<Union>_<Tag>` carrier records are never emitted for finds.
    expect(wf).not.toContain("ProjectOrProjectNotFound_");
  });

  it("seed datetime string literals parse to Instant", async () => {
    const seed = find(await build(), "infrastructure/persistence/CatalogSeedRunner.java");
    expect(seed).toContain('Instant.parse("2024-01-01T00:00:00Z")');
    expect(seed).toContain("import java.time.Instant;");
  });
});
