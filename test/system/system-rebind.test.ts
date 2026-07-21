import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AstNode, Model } from "../../src/language/generated/ast.js";
import {
  currentTarget,
  type RebindKind,
  rebindReference,
  rebindTargets,
} from "../../web/src/builder/system/rebind.js";
import { parseRaw as parse } from "../_helpers/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(path.join(here, "..", "..", rel), "utf8");
const sales = read("examples/sales.ddd");
const acme = read("examples/acme.ddd");

function find(m: Model, type: string, name: string): AstNode {
  for (const n of walk(m))
    if (n.$type === type && (n as { name?: string }).name === name) return n as AstNode;
  throw new Error(`not found: ${type} ${name}`);
}
function* walk(node: { $type: string }): Generator<{ $type: string }> {
  yield node;
  for (const v of Object.values(node)) {
    if (Array.isArray(v))
      for (const c of v)
        if (c && typeof c === "object" && "$type" in c) yield* walk(c);
        else if (v && typeof v === "object" && "$type" in v) yield* walk(v as { $type: string });
  }
}

describe("System builder — rebind a construct's reference", () => {
  it("rebinds a repository's target aggregate", () => {
    const out = rebindReference(sales, "repository", "Orders", "Customer");
    expect(out).toMatch(/repository Orders for Customer\b/);
    // The find params inside the body (Customer id) are untouched — only the
    // `for` reference token moved.
    expect(out).toMatch(/find byCustomer\(customerId: Customer id\)/);
  });

  it("rebinds an api's source module", () => {
    const out = rebindReference(acme, "api", "CustomerMgmtApi", "Sales");
    expect(out).toMatch(/api CustomerMgmtApi from Sales\b/);
  });

  it("reports the current target and the candidate set", () => {
    const repo = find(parse(sales), "Repository", "Orders");
    expect(currentTarget(repo, "repository")).toBe("Order");
    const aggs = rebindTargets(parse(sales), "repository" satisfies RebindKind);
    expect(aggs).toEqual(expect.arrayContaining(["Customer", "Order", "Product"]));
    const mods = rebindTargets(parse(acme), "api");
    expect(mods).toEqual(expect.arrayContaining(["CustomerMgmt", "Sales"]));
  });

  it("returns null for an unknown construct", () => {
    expect(rebindReference(sales, "repository", "Nope", "Customer")).toBeNull();
  });
});
