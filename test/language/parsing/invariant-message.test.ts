// Custom validation messages (M-T1.11 slice): the `message "..."` clause on
// invariant / check / precondition parses, sets the AST field, and — being a
// soft keyword — still admits `message` as an ordinary field/identifier name.

import { NodeFileSystem } from "langium/node";
import { parseHelper } from "langium/test";
import { beforeAll, describe, expect, it } from "vitest";
import { createDddServices } from "../../../src/language/ddd-module.js";
import type { Aggregate, Invariant, Model, Property } from "../../../src/language/generated/ast.js";

describe("invariant/check/precondition `message` clause", () => {
  let parse: ReturnType<typeof parseHelper>;
  beforeAll(() => {
    parse = parseHelper(createDddServices(NodeFileSystem).Ddd);
  });

  const parseAgg = async (src: string) => {
    const doc = await parse(src);
    const ctx = (doc.parseResult.value as Model).members.find((m) => m.$type === "BoundedContext");
    // biome-ignore lint/suspicious/noExplicitAny: test navigation
    const agg = (ctx as any)?.members?.find((m: { $type: string }) => m.$type === "Aggregate") as
      | Aggregate
      | undefined;
    return { errs: doc.parseResult.parserErrors.map((e) => e.message).join("; "), agg };
  };

  it("sets `message` on an invariant and a property `check`", async () => {
    const { errs, agg } = await parseAgg(`context C {
      aggregate Product {
        sku: string check sku.length > 0 message "SKU is required"
        name: string
        invariant name.length >= 2 message "Name too short"
        invariant sku.length > 0
      }
    }`);
    expect(errs).toBe("");
    const inv = agg?.members.find((m) => m.$type === "Invariant") as Invariant | undefined;
    expect(inv?.message).toBe("Name too short");
    const sku = agg?.members.find(
      (m) => m.$type === "Property" && (m as Property).name === "sku",
    ) as Property | undefined;
    expect(sku?.message).toBe("SKU is required");
    // A message-less invariant leaves the field undefined.
    const bare = agg?.members.filter((m) => m.$type === "Invariant") as Invariant[];
    expect(bare.find((i) => i.message === undefined)).toBeTruthy();
  });

  it("keeps `message` usable as a field name (soft keyword)", async () => {
    const { errs, agg } = await parseAgg(`context C {
      aggregate Note { message: string }
    }`);
    expect(errs).toBe("");
    const f = agg?.members.find((m) => m.$type === "Property") as Property | undefined;
    expect(f?.name).toBe("message");
  });
});
