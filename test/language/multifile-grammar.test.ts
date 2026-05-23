import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import type { EnumDecl, ImportStmt, Model, ValueObject } from "../../src/language/generated/ast.js";

async function parse(src: string): Promise<{ model: Model; errors: string[] }> {
  const services = createDddServices(NodeFileSystem);
  const helper = parseHelper(services.Ddd);
  const doc = await helper(src, { validation: true });
  const errors = (doc.diagnostics ?? [])
    .filter((d) => d.severity === 1)
    .map((d) => `${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`);
  return { model: doc.parseResult.value as Model, errors };
}

describe("multi-file grammar surface", () => {
  it("parses leading import statements", async () => {
    const { model, errors } = await parse(`
      import "./shared/money.ddd"
      import "./orders.ddd";
      context Empty { }
    `);
    expect(errors).toEqual([]);
    expect(model.imports).toHaveLength(2);
    const paths = (model.imports as ImportStmt[]).map((i) => i.path);
    expect(paths).toEqual(["./shared/money.ddd", "./orders.ddd"]);
  });

  it("parses a root-level valueobject", async () => {
    const { model, errors } = await parse(`
      valueobject Money {
        amount: decimal
        currency: string
      }
    `);
    expect(errors).toEqual([]);
    const vos = model.members.filter((m): m is ValueObject => m.$type === "ValueObject");
    expect(vos).toHaveLength(1);
    expect(vos[0]!.name).toBe("Money");
  });

  it("parses a root-level enum", async () => {
    const { model, errors } = await parse(`
      enum Currency { USD, EUR, GBP }
    `);
    expect(errors).toEqual([]);
    const enums = model.members.filter((m): m is EnumDecl => m.$type === "EnumDecl");
    expect(enums).toHaveLength(1);
    expect(enums[0]!.name).toBe("Currency");
    expect(enums[0]!.values.map((v) => v.name)).toEqual(["USD", "EUR", "GBP"]);
  });

  it("resolves a root-level valueobject as a field type inside a context", async () => {
    const { errors } = await parse(`
      valueobject Money {
        amount: decimal
        currency: string
      }
      context Sales {
        aggregate Order {
          total: Money
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("resolves a root-level enum as a field type inside a context", async () => {
    const { errors } = await parse(`
      enum OrderStatus { Draft, Confirmed }
      context Sales {
        aggregate Order {
          status: OrderStatus
        }
      }
    `);
    expect(errors).toEqual([]);
  });

  it("imports + root decls + context all coexist", async () => {
    const { model, errors } = await parse(`
      import "./other.ddd"
      valueobject Money {
        amount: decimal
        currency: string
      }
      enum OrderStatus { Draft, Confirmed }
      context Sales {
        aggregate Order {
          total: Money
          status: OrderStatus
        }
      }
    `);
    expect(errors).toEqual([]);
    expect(model.imports).toHaveLength(1);
    expect(model.members.filter((m) => m.$type === "ValueObject")).toHaveLength(1);
    expect(model.members.filter((m) => m.$type === "EnumDecl")).toHaveLength(1);
    expect(model.members.filter((m) => m.$type === "BoundedContext")).toHaveLength(1);
  });
});
