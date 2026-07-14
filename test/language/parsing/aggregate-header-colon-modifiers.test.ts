// M-T5.17 (finding #1) — aggregate-header enum-axis modifiers accept a COLON
// clause (`persistedAs: eventLog`), matching every other enum-value pick in
// Loom, alongside the legacy PAREN form (`persistedAs(eventLog)`) which stays
// accepted (Phase 1 accept-both).  Both spellings must parse to the SAME AST.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Model } from "../../../src/language/generated/ast.js";

describe("aggregate-header colon modifiers (M-T5.17)", () => {
  let parse: ReturnType<typeof parseHelper>;
  beforeAll(() => {
    parse = parseHelper(createDddServices(NodeFileSystem).Ddd);
  });

  const firstAggregate = async (src: string) => {
    const doc = await parse(src);
    expect(
      doc.parseResult.parserErrors.map((e) => e.message).join("; "),
      `must parse:\n${src}`,
    ).toBe("");
    const ctx = (doc.parseResult.value as Model).members.find((m) => m.$type === "BoundedContext");
    // biome-ignore lint/suspicious/noExplicitAny: test navigation
    return (ctx as any).members.find(
      (m: { $type: string }) => m.$type === "Aggregate",
    ) as Aggregate;
  };

  it("colon form parses and sets the same fields as the paren form", async () => {
    const colon = await firstAggregate(`context C {
      aggregate Ledger persistedAs: eventLog shape: document {
        name: string
      }
    }`);
    const paren = await firstAggregate(`context C {
      aggregate Ledger persistedAs(eventLog) shape(document) {
        name: string
      }
    }`);
    expect(colon.persistedAs).toBe("eventLog");
    expect(colon.shape).toBe("document");
    expect(colon.persistedAs).toBe(paren.persistedAs);
    expect(colon.shape).toBe(paren.shape);
  });

  it("colon form works for inheritanceUsing on an abstract base + subtype", async () => {
    const base = await firstAggregate(`context C {
      abstract aggregate Account inheritanceUsing: ownTable {
        balance: decimal
      }
    }`);
    expect(base.isAbstract).toBe(true);
    expect(base.inheritanceUsing).toBe("ownTable");
  });

  it("accepts a trailing comma between colon modifiers", async () => {
    const agg = await firstAggregate(`context C {
      aggregate Doc persistedAs: eventLog, shape: embedded {
        name: string
      }
    }`);
    expect(agg.persistedAs).toBe("eventLog");
    expect(agg.shape).toBe("embedded");
  });
});
