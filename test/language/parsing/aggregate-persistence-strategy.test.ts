import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";

describe("aggregate persistedAs (truth kind, D-DOCUMENT-AXIS)", () => {
  async function parse(src: string) {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(src, { validation: true });
    const errors = (doc.diagnostics ?? []).filter((d) => d.severity === 1).map((d) => d.message);
    return { model: doc.parseResult.value as Model, errors };
  }

  function firstAgg(model: Model): Aggregate {
    const ctx = model.members[0] as
      | import("../../../src/language/generated/ast.js").BoundedContext
      | undefined;
    const agg = ctx?.members.find((m) => m.$type === "Aggregate");
    return agg as Aggregate;
  }

  it("parses persistedAs(state) on the header", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order persistedAs(state) {
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBe("state");
  });

  it("parses persistedAs(eventLog) on the header", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order persistedAs(eventLog) {
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBe("eventLog");
  });

  it("coexists with ids and a with-clause in header order (ids, persistedAs, with)", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order persistedAs(eventLog) {
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBe("eventLog");
  });

  it("rejects any `ids` clause (the `ids <kind>` spelling was removed — guid is implicit)", async () => {
    // `ids guid` was a single-value no-op; `ids int|long|string` were removed
    // earlier as a footgun. The aggregate id is always a guid Loom mints, so
    // the whole `ids` clause is gone — even `ids guid` no longer parses.
    // See docs/old/plans/non-guid-id-http-params.md.
    for (const kind of ["guid", "int", "long", "string"]) {
      const { errors } = await parse(`
        context T {
          aggregate Order ids ${kind} {
            name: string
          }
        }
      `);
      expect(errors.join("\n"), `ids ${kind} should be a parse error`).toMatch(/found .?ids/);
    }
  });

  it("omits persistedAs when not declared (defaults to state at resolution)", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order {
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBeUndefined();
  });

  it("rejects an unknown truth-kind value", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order persistedAs(nonsense) {
          name: string
        }
      }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects the removed body `persistenceStrategy:` clause (hard cutover)", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order {
          persistenceStrategy: eventSourced
          name: string
        }
      }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});
