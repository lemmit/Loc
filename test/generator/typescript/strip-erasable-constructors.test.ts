// M19 phase 8 slice 2 (docs/plans/dap-node-debug.md, "Non-erasable syntax
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
// This is the durable tripwire: no emitted domain-layer `.ts` file (the
// aggregate/entity/value-object/id/event/error modules under any
// deployable's `domain/` directory — the set the design doc characterized as
// "erasable-only... value objects [were] the exception") may carry a
// `constructor(...)` with a public/private/protected modifier on a
// parameter.
//
// KNOWN, SEPARATE, NOT-YET-FIXED GAP (found while proving this slice's
// payoff, out of this slice's scope — see the design doc's Follow-ups):
// the repository/reader/persistence-adapter constructors
// (`repository-builder.ts` + siblings, `emit/mikroorm.ts`) and the Playwright
// page-object constructors (`src/generator/_frontend/*-page-object*.ts`,
// `page-objects-builder.ts`) ALSO emit parameter properties
// (`constructor(private readonly db: Db, ...)` /
// `constructor(public readonly page: Page) {}`). Those files sit OUTSIDE
// `domain/` (db/repositories/, e2e/pages/) and are deliberately NOT covered
// by this tripwire — fixing them is its own follow-up slice, same reasoning
// the design doc used to scope this one. Do not widen this test's file
// filter to "every emitted .ts file" without first landing that follow-up,
// or it fails on a gap this slice never promised to close.
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

async function buildAcme(): Promise<Model> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.file(path.join(repoRoot, "examples/acme.ddd")));
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  return doc.parseResult.value as Model;
}

describe("strip-erasable constructors (Node type-stripping compatibility)", () => {
  it("no domain-layer .ts file in the acme system carries a parameter-property constructor", async () => {
    const model = await buildAcme();
    const { files } = generateSystems(model);
    const offenders: string[] = [];
    for (const [name, content] of files) {
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      if (!name.includes("/domain/")) continue;
      if (PARAMETER_PROPERTY_RE.test(content)) offenders.push(name);
    }
    expect(offenders, "domain-layer files with a parameter-property constructor").toEqual([]);
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
