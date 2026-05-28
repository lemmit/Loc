import { NodeFileSystem } from "langium/node";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";

describe("aggregate persistenceStrategy", () => {
  async function parse(src: string) {
    const { parseHelper } = await import("langium/test");
    const services = createDddServices(NodeFileSystem);
    const helper = parseHelper(services.Ddd);
    const doc = await helper(src, { validation: true });
    const errors = (doc.diagnostics ?? [])
      .filter((d) => d.severity === 1)
      .map((d) => d.message);
    return { model: doc.parseResult.value as Model, errors };
  }

  function firstAgg(model: Model): Aggregate {
    const ctx = model.members[0] as
      | import("../../../src/language/generated/ast.js").BoundedContext
      | undefined;
    const agg = ctx?.members.find((m) => m.$type === "Aggregate");
    return agg as Aggregate;
  }

  it("parses stateBased", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order {
          persistenceStrategy: stateBased
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistenceStrategy).toBe("stateBased");
  });

  it("parses eventSourced", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order {
          persistenceStrategy: eventSourced
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistenceStrategy).toBe("eventSourced");
  });

  it("omits persistenceStrategy when not declared", async () => {
    const { model, errors } = await parse(`
      context T {
        aggregate Order {
          name: string
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(firstAgg(model).persistenceStrategy).toBeUndefined();
  });

  it("rejects an unknown strategy value", async () => {
    const { errors } = await parse(`
      context T {
        aggregate Order {
          persistenceStrategy: nonsense
          name: string
        }
      }
    `);
    expect(errors.length).toBeGreaterThan(0);
  });
});
