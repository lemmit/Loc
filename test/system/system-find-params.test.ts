import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Model } from "../../src/language/generated/ast.js";
import {
  addFindParam,
  deleteFindParam,
  findReturnSpec,
  listFindParams,
  listFinds,
  renameFindParam,
  retypeFindParam,
  setFindReturnType,
} from "../../web/src/builder/system/find-params.js";
import { parseRaw as parse } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sales = readFileSync(path.join(here, "..", "..", "examples", "sales.ddd"), "utf8");
function repo(m: Model): import("../../src/language/generated/ast.js").Repository {
  for (const n of (function* walk(x: { $type: string }): Generator<{ $type: string }> {
    yield x;
    for (const v of Object.values(x)) {
      if (Array.isArray(v))
        for (const c of v)
          if (c && typeof c === "object" && "$type" in c) yield* walk(c);
          else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
    }
  })(m)) {
    if (n.$type === "Repository" && (n as { name?: string }).name === "Orders") return n as never;
  }
  throw new Error("no Orders repo");
}

describe("System builder — repository find params", () => {
  it("lists finds and their params", () => {
    expect(listFinds(repo(parse(sales)))).toEqual(["byCustomer", "activeForCustomer"]);
    const params = listFindParams(parse(sales), "Orders", "activeForCustomer");
    expect(params).toEqual([
      {
        name: "forCustomer",
        base: { kind: "id", target: "Customer" },
        baseLabel: "Id<Customer>",
        array: false,
        optional: false,
      },
    ]);
  });

  it("reads the return type", () => {
    expect(findReturnSpec(parse(sales), "Orders", "byCustomer")).toEqual({
      base: { kind: "named", target: "Order" },
      array: true,
      optional: false,
    });
  });

  it("adds, retypes, and deletes a param", () => {
    expect(
      addFindParam(sales, "Orders", "byCustomer", "since", {
        base: { kind: "primitive", name: "datetime" },
        array: false,
        optional: false,
      }),
    ).toMatch(/find byCustomer\(customerId: Id<Customer>, since: datetime\)/);
    expect(
      retypeFindParam(sales, "Orders", "byCustomer", 0, {
        base: { kind: "primitive", name: "string" },
        array: false,
        optional: false,
      }),
    ).toMatch(/find byCustomer\(customerId: string\)/);
    expect(deleteFindParam(sales, "Orders", "byCustomer", 0)).toMatch(/find byCustomer\(\)/);
  });

  it("renames a param and updates its filter usages", () => {
    const out = renameFindParam(sales, "Orders", "activeForCustomer", 0, "cust")!;
    expect(out).toMatch(/find activeForCustomer\(cust: Id<Customer>\)/);
    expect(out).toMatch(/this\.customerId == cust && this\.status == Draft/);
  });

  it("edits the return type", () => {
    expect(
      setFindReturnType(sales, "Orders", "byCustomer", {
        base: { kind: "named", target: "Order" },
        array: false,
        optional: false,
      }),
    ).toMatch(/find byCustomer\(customerId: Id<Customer>\): Order\b/);
  });

  it("returns null for unknown repo / find / index", () => {
    expect(deleteFindParam(sales, "Nope", "x", 0)).toBeNull();
    expect(deleteFindParam(sales, "Orders", "nope", 0)).toBeNull();
    expect(deleteFindParam(sales, "Orders", "byCustomer", 9)).toBeNull();
  });
});
