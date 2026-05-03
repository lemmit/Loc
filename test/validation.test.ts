import { describe, expect, it } from "vitest";
import { NodeFileSystem } from "langium/node";
import { URI } from "langium";
import { createDddServices } from "../src/language/ddd-module.js";

async function parseSource(source: string): Promise<{ errors: string[]; warnings: string[] }> {
  const services = createDddServices(NodeFileSystem);
  const docs = services.shared.workspace.LangiumDocuments;
  const doc = await docs.getOrCreateDocument(URI.parse(`file:///inmem-${Math.random().toString(36).slice(2)}.ddd`));
  doc.textDocument = {
    uri: doc.textDocument.uri,
    languageId: "ddd",
    version: 1,
    getText: () => source,
    positionAt: () => ({ line: 0, character: 0 }),
    offsetAt: () => 0,
    lineCount: source.split("\n").length,
  } as never;
  // Force re-build by rebuilding from text
  await services.shared.workspace.DocumentBuilder.build([doc], { validation: true });
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const d of doc.diagnostics ?? []) {
    if (d.severity === 1) errors.push(d.message);
    else if (d.severity === 2) warnings.push(d.message);
  }
  return { errors, warnings };
}

// Convenience: parse from a string by writing to a temp file (URI.parse on
// in-memory text isn't picked up by the Langium document builder in the
// standard config — use the langium/test parseHelper instead).
import { parseHelper } from "langium/test";

async function parse(source: string) {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(source, { validation: true });
  const diags = doc.diagnostics ?? [];
  return {
    errors: diags.filter((d) => d.severity === 1).map((d) => d.message),
    warnings: diags.filter((d) => d.severity === 2).map((d) => d.message),
  };
}

void parseSource; // keep helper around; use `parse` below

describe("validation", () => {
  it("flags non-bool invariants", async () => {
    const { errors } = await parse(`
      context T {
        valueobject V {
          n: int
          invariant n + 1
        }
      }
    `);
    expect(errors.some((e) => /invariant/i.test(e) && /bool/i.test(e))).toBe(true);
  });

  it("flags non-bool preconditions", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          operation tweak(y: int) {
            precondition x + y
          }
        }
      }
    `);
    expect(errors.some((e) => /precondition/i.test(e) && /bool/i.test(e))).toBe(true);
  });

  it("flags emit field shape mismatch", async () => {
    const { errors } = await parse(`
      context T {
        event Done { who: string }
        aggregate A {
          name: string
          operation finish() {
            emit Done { who: 42 }
          }
        }
      }
    `);
    expect(errors.some((e) => /Done/.test(e) || /string/.test(e))).toBe(true);
  });

  it("accepts a well-typed aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          invariant x >= 0
          operation bump() {
            precondition x >= 0
            x := x + 1
          }
        }
      }
    `);
    expect(errors).toEqual([]);
  });
});
