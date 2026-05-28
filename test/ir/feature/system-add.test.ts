import { AstUtils, EmptyFileSystem } from "langium";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Model } from "../../../src/language/generated/ast.js";
import {
  addConstructSource,
  listContextNames,
  listSubdomainNames,
} from "../../../web/src/builder/system/add.js";

const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;
const parse = (t: string): Model => parser.parse(t).value as Model;

const SRC = `system S {
  subdomain Sales {
    context Orders {
      aggregate Order {
      }
    }
  }
  subdomain Billing {
    context Invoices {
      aggregate Invoice {
      }
    }
  }
}`;

/** The bounded-context name containing the aggregate named `agg`, by walking
 *  $container up the parsed tree. */
function contextOf(src: string, agg: string): string | undefined {
  for (const n of AstUtils.streamAst(parse(src))) {
    if (n.$type === "Aggregate" && (n as { name: string }).name === agg) {
      let p = n.$container;
      while (p && p.$type !== "BoundedContext") p = p.$container;
      return (p as { name?: string } | undefined)?.name;
    }
  }
  return undefined;
}

describe("System builder — add target picker", () => {
  it("lists context and subdomain names in document order", () => {
    expect(listContextNames(parse(SRC))).toEqual(["Orders", "Invoices"]);
    expect(listSubdomainNames(parse(SRC))).toEqual(["Sales", "Billing"]);
  });

  it("adds a domain construct into the chosen context", () => {
    const next = addConstructSource(SRC, "aggregate", { context: "Invoices" })!;
    expect(next).not.toBeNull();
    expect(contextOf(next, "Aggregate1")).toBe("Invoices");
  });

  it("defaults to the first context, and falls back to it for an unknown pick", () => {
    expect(contextOf(addConstructSource(SRC, "aggregate")!, "Aggregate1")).toBe("Orders");
    expect(
      contextOf(addConstructSource(SRC, "aggregate", { context: "Nope" })!, "Aggregate1"),
    ).toBe("Orders");
  });

  it("references an aggregate from the chosen context for a repository", () => {
    const next = addConstructSource(SRC, "repository", { context: "Invoices" })!;
    expect(next).toContain("for Invoice");
    expect(next).not.toContain("for Order ");
  });

  it("points an api at the chosen subdomain (first by default)", () => {
    expect(addConstructSource(SRC, "api", { subdomain: "Billing" })!).toContain("from Billing");
    expect(addConstructSource(SRC, "api")!).toContain("from Sales");
  });
});
