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
        aggregate Order ids guid persistedAs(eventLog) {
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistedAs).toBe("eventLog");
    expect(firstAgg(model).idKind).toBe("guid");
  });

  it("rejects a non-guid id kind (`ids int|long|string` were removed — guid only)", async () => {
    // No backend implemented id generation for a non-guid PK, so the surface
    // was removed; `guid` is the only accepted id kind.  See
    // docs/plans/non-guid-id-http-params.md.
    for (const kind of ["int", "long", "string"]) {
      const { errors } = await parse(`
        context T {
          aggregate Order ids ${kind} {
            name: string
          }
        }
      `);
      expect(errors.join("\n"), `ids ${kind} should be a parse error`).toMatch(
        /Expecting token of type 'guid'/,
      );
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
