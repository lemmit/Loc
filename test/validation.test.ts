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

  it("accepts a single string `display` field on an aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          sku: string display
          desc: string
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("rejects multiple `display` fields on an aggregate", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          sku: string display
          name: string display
        }
      }
    `);
    expect(errors.some((e) => /multiple 'display' fields/i.test(e))).toBe(true);
  });

  it("rejects `display` on a non-string field", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Product {
          qty: int display
        }
      }
    `);
    expect(errors.some((e) => /must have type 'string'/i.test(e))).toBe(true);
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

  it("rejects find with non-queryable where (collection op)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          customerId: string
          contains lines: OrderLine[]
          entity OrderLine { qty: int }
        }
        repository Orders for Order {
          find big(): Order[] where this.lines.count > 0
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /find 'big': where-clause is not queryable/.test(d.message) &&
          /collection projection '\.count'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects find with non-queryable where (lambda)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order {
          customerId: string
          contains lines: OrderLine[]
          entity OrderLine { qty: int }
        }
        repository Orders for Order {
          find anyBig(): Order[] where this.lines.any(l => l.qty > 5)
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /find 'anyBig': where-clause is not queryable/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts queryable where clauses (binary, &&, refs)", async () => {
    const loom = await loomFrom(`
      context T {
        enum OrderStatus { Open, Closed }
        aggregate Order {
          customerId: string
          status: OrderStatus
        }
        repository Orders for Order {
          find activeForCustomer(c: string): Order[]
            where this.customerId == c && this.status == Open
        }
      }
    `);
    const diags = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(diags).toEqual([]);
  });

  it("rejects find name 'save' (collides with auto-emitted save method)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Order { sku: string display }
        repository Orders for Order {
          find save(s: string): Order[] where this.sku == s
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /find 'save': name collides with the auto-emitted/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects Id<X> referencing a non-mounted aggregate (react deployable)", async () => {
    const loom = await loomFrom(`
      system S {
        module Customers { context C { aggregate Customer { name: string display } } }
        module Sales {
          context T {
            aggregate Order {
              customerId: Id<Customer>
            }
          }
        }
        deployable api { platform: hono, modules: Sales, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references Id<Customer>, but 'Customer' is not mounted/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects Id<X> targeting an aggregate without a 'display' field (react deployable)", async () => {
    const loom = await loomFrom(`
      system S {
        module M {
          context T {
            aggregate Customer { email: string }
            aggregate Order { customerId: Id<Customer> }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references Id<Customer>, but 'Customer' has no 'display' field/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects where-clause referencing an unknown aggregate field", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Task { name: string display }
        repository Tasks for Task {
          find byUnknown(p: string): Task[] where this.unknownField == p
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /references unknown field 'this\.unknownField'/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("rejects where-clause comparing two columns (no value side)", async () => {
    const loom = await loomFrom(`
      context T {
        aggregate Task { name: string display, alt: string }
        repository Tasks for Task {
          find both(): Task[] where this.name == this.alt
        }
      }
    `);
    const diags = validateLoomModel(loom);
    expect(
      diags.some(
        (d) =>
          d.severity === "error" &&
          /comparison between two columns \('this\.name' vs 'this\.alt'\)/.test(d.message),
      ),
      JSON.stringify(diags),
    ).toBe(true);
  });

  it("accepts Id<X> when the target is mounted AND has a display field", async () => {
    const loom = await loomFrom(`
      system S {
        module M {
          context T {
            aggregate Customer { name: string display }
            aggregate Order { customerId: Id<Customer> }
          }
        }
        deployable api { platform: hono, modules: M, port: 3000 }
        deployable web { platform: react, targets: api, port: 3001 }
      }
    `);
    const errors = validateLoomModel(loom).filter((d) => d.severity === "error");
    expect(errors, JSON.stringify(errors)).toEqual([]);
  });
});
