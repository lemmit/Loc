// M19 phase 8 slice 2 (docs/old/plans/dap-node-debug.md, "Non-erasable syntax
// — RESOLVED (slice 2)"). The value object's constructor
// (`constructor(public readonly amount: number, ...)`) was a TypeScript
// parameter property — sugar the type checker must desugar, not syntax that
// erases to nothing — which Node's `--experimental-strip-types` / unflagged
// type-stripping (Node 24) rejects outright (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
// It was also the ONE parameter-property constructor on the domain-module
// load path a request-handling boot forces through (repository hydration,
// route body parsing construct VOs at runtime) — see the design doc's Phase
// A finding 2.
//
// RESOLVED (slice 3, Milestone 20). The repository/reader/persistence-adapter
// constructors (`repository-builder.ts` + siblings, `base-reader-builder.ts`,
// `emit/mikroorm.ts`) and the Playwright page-object constructors
// (`src/generator/_frontend/*-page-object*.ts`, `page-objects-builder.ts`,
// `src/generator/elixir/page-objects-emit.ts`) now emit explicit field
// declarations + constructor assignments too — the same mechanical rewrite
// slice 2 used for value objects. This is the durable tripwire, widened:
// EVERY emitted `.ts`/`.tsx` file in the system (domain layer, `db/`
// repositories, and `e2e/pages/` Playwright page objects alike) may carry no
// `constructor(...)` with a public/private/protected modifier on a
// parameter — the whole plain-Node emitted project, plus the emitted
// Playwright specs, is strip-erasable.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { URI } from "langium";
import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import { generateSystems } from "../../../src/system/index.js";
import { generateSystemFiles } from "../../_helpers/generate.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

// A parameter-property constructor: `constructor(` (possibly spanning
// multiple lines, since the emitter formats one param per line) followed by
// a public/private/protected modifier on a parameter.
const PARAMETER_PROPERTY_RE = /constructor\s*\(\s*(?:\n\s*)*(public|private|protected)\b/;

async function buildFixture(rel: string): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.file(path.join(repoRoot, rel)));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

// Two fixtures, deliberately: `acme.ddd` is the everyday shape, but
// `showcase.ddd` is the single-file conformance fixture built to exercise
// EVERY language feature (test/conformance/showcase-completeness.test.ts
// hard-gates that) — so it reaches emitter paths acme never triggers
// (eventsourced + document repositories, every page-object kind, the full
// design-pack `.tsx` surface). Scanning both is what makes this tripwire a
// real repo-wide gate rather than an acme-only one; a parameter property
// reintroduced on a showcase-only path would slip past acme alone.
const STRIP_FIXTURES = ["examples/acme.ddd", "examples/showcase.ddd"] as const;

describe("strip-erasable constructors (Node type-stripping compatibility)", () => {
  it.each(
    STRIP_FIXTURES,
  )("no emitted .ts/.tsx file in %s carries a parameter-property constructor", async (rel) => {
    const model = await buildFixture(rel);
    const { files } = generateSystems(model);
    const offenders: string[] = [];
    for (const [name, content] of files) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (PARAMETER_PROPERTY_RE.test(content)) offenders.push(name);
    }
    expect(offenders, "emitted files with a parameter-property constructor").toEqual([]);
  });

  it("value-objects.ts specifically: explicit field declarations, not parameter properties", async () => {
    const files = await generateSystemFiles(`
      system PP {
        subdomain D {
          context Shop {
            valueobject Money {
              amount: int
              currency: string
            }
            aggregate Item with crudish {
              price: Money
            }
            repository Items for Item { }
          }
        }
        api A from D
        storage primary { type: postgres }
        resource st { for: Shop, kind: state, use: primary }
        deployable d { platform: node, contexts: [Shop], dataSources: [st], serves: A, port: 3000 }
      }
    `);
    const vo = files.get("d/domain/value-objects.ts")!;
    expect(vo).toBeDefined();
    expect(vo).not.toMatch(PARAMETER_PROPERTY_RE);
    expect(vo).toContain("readonly amount: number;");
    expect(vo).toContain("readonly currency: string;");
    expect(vo).toContain("this.amount = amount;");
    expect(vo).toContain("this.currency = currency;");
  });
});
