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

  it("rejects assignment to a derived property", async () => {
    const { errors } = await parse(`
      context T {
        aggregate A {
          x: int
          derived doubled: int = x * 2
          operation tweak() {
            doubled := 0
          }
        }
      }
    `);
    expect(errors.some((e) => /derived/i.test(e))).toBe(true);
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

  it("rejects a react deployable without 'targets:'", async () => {
    const { errors } = await parse(`
      system S {
        module M { context T { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, port: 3001 }
      }
    `);
    expect(errors.some((e) => /targets/i.test(e))).toBe(true);
  });

  it("rejects 'targets:' on a non-react deployable", async () => {
    const { errors } = await parse(`
      system S {
        module M { context T { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable other { platform: hono, modules: M, targets: api, port: 3010 }
      }
    `);
    expect(errors.some((e) => /targets/i.test(e))).toBe(true);
  });

  it("rejects a react deployable targeting another react deployable", async () => {
    const { errors } = await parse(`
      system S {
        module M { context T { aggregate A { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable webA { platform: react, targets: api, port: 3001 }
        deployable webB { platform: react, targets: webA, port: 3002 }
      }
    `);
    expect(errors.some((e) => /frontend/i.test(e) && /target/i.test(e))).toBe(
      true,
    );
  });
});

describe("Loom IR validation (post-lowering)", async () => {
  const { lowerModel } = await import("../src/ir/lower.js");
  const { enrichLoomModel } = await import("../src/ir/enrichments.js");
  const { validateLoomModel } = await import("../src/ir/validate.js");
  const { parseHelper } = await import("langium/test");
  const { createDddServices } = await import("../src/language/ddd-module.js");

  async function loomFrom(src: string) {
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(src, { validation: true });
    const model = doc.parseResult.value as import("../src/language/generated/ast.js").Model;
    return enrichLoomModel(lowerModel(model));
  }

  it("rejects api.<unknown> in test e2e", async () => {
    const loom = await loomFrom(`
      system S {
        module M { context T { aggregate Order { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        test e2e "missing aggregate" against api {
          let _ = api.unknown.create({})
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /unknown aggregate 'api\.unknown'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("rejects api.<known>.<unknownVerb> in test e2e", async () => {
    const loom = await loomFrom(`
      system S {
        module M { context T { aggregate Order { x: int } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        test e2e "bad verb" against api {
          let _ = api.orders.frobnicate({})
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /unknown method 'api\.orders\.frobnicate'/.test(d.message),
      ),
    ).toBe(true);
  });

  it("accepts well-formed api e2e tests with no diagnostics", async () => {
    const loom = await loomFrom(`
      system S {
        module M { context T { aggregate Order { customerId: string } } }
        deployable api { platform: hono, modules: M, port: 3000 }
        test e2e "good" against api {
          let o = api.orders.create({ customerId: "c-1" })
          let read = api.orders.getById(o)
          let listed = api.orders.all({})
          expect read.customerId == "c-1"
        }
      }
    `);
    const diags = validateLoomModel(loom);
    const errors = diags.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });
});
