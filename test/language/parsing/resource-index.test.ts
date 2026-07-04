// `resource index: [...]` — the manual performance-index escape hatch on the
// storage binding (uniqueness-and-indexes.md §3.2, D-INDEX-INFRA).  The target
// entity is named explicitly: `Entity.col` (single column) or `Entity.(a, b)`
// (composite).  The entity may be an aggregate or a contained part.

import { AstUtils } from "langium";
import { describe, expect, it } from "vitest";
import { isResource, type Model, type Resource } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

function firstResource(model: Model): Resource {
  for (const node of AstUtils.streamAllContents(model)) {
    if (isResource(node)) return node;
  }
  throw new Error("no resource found");
}

const wrap = (resource: string) => `
  system Shop {
    subdomain Sales {
      context Ordering {
        aggregate Customer with crudish {
          email: string  status: string  lastName: string
          contains lines: Line[]
          entity Line { sku: string }
        }
        repository Customers for Customer { }
      }
    }
    api SalesApi from Sales
    storage primarySql { type: postgres }
    ${resource}
    deployable api { platform: node  contexts: [Ordering]  dataSources: [ordState]  serves: SalesApi  port: 3001 }
  }
`;

describe("resource index: — parsing", () => {
  it("parses single-column index specs (Entity.col)", async () => {
    const { model, errors } = await parseString(
      wrap(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.status, Customer.lastName] }`,
      ),
    );
    expect(errors).toEqual([]);
    const specs = firstResource(model).indexes.map((s) => [s.entity, [...s.columns]]);
    expect(specs).toEqual([
      ["Customer", ["status"]],
      ["Customer", ["lastName"]],
    ]);
  });

  it("parses a composite index spec (Entity.(a, b))", async () => {
    const { model, errors } = await parseString(
      wrap(
        `resource ordState { for: Ordering, kind: state, use: primarySql, index: [Customer.status, Customer.(status, lastName)] }`,
      ),
    );
    expect(errors).toEqual([]);
    const specs = firstResource(model).indexes.map((s) => [s.entity, [...s.columns]]);
    expect(specs).toEqual([
      ["Customer", ["status"]],
      ["Customer", ["status", "lastName"]],
    ]);
  });

  it("targets a contained part entity", async () => {
    const { model, errors } = await parseString(
      wrap(`resource ordState { for: Ordering, kind: state, use: primarySql, index: [Line.sku] }`),
    );
    expect(errors).toEqual([]);
    const specs = firstResource(model).indexes.map((s) => [s.entity, [...s.columns]]);
    expect(specs).toEqual([["Line", ["sku"]]]);
  });
});
