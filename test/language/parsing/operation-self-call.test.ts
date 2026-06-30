// Grammar coverage for an in-class operation calling a SIBLING operation in its
// body — the surface the Elixir-vanilla op-self-call lowering / gate consume.
// No new syntax: an op-call is an ordinary call expression, so it parses in any
// expression position (`return reserve()`, `let x = reserve()`, nested).  The
// tail-vs-non-tail distinction is a SEMANTIC (validation) concern on vanilla
// (loom.vanilla-op-call-position), not a parse error — so all three forms parse
// clean here, with no platform/deployable in the snippet.

import { describe, expect, it } from "vitest";
import { isAggregate, isBoundedContext, isOperation } from "../../../src/language/generated/ast.js";
import { parseString } from "../../_helpers/parse.js";

describe("parsing — operation self-call", () => {
  it("parses a sibling-operation call in return, let, and nested positions", async () => {
    const { model, errors } = await parseString(`
      context Catalog {
        aggregate Item {
          code: string
          private operation helper(): string { return code }
          operation reserve(): string { return code }
          operation tailCall(): string { return reserve() }
          operation letBind(): string {
            let x = reserve()
            return x
          }
          operation nested(): string { return reserve() + "!" }
          operation viaPrivate(): string { return helper() }
        }
      }
    `);
    expect(errors).toEqual([]);
    const ctx = model.members.find(isBoundedContext)!;
    const agg = ctx.members.find(isAggregate)!;
    // All five operations + the private helper parse onto the aggregate.
    expect(agg.members.filter(isOperation).map((o) => o.name)).toEqual([
      "helper",
      "reserve",
      "tailCall",
      "letBind",
      "nested",
      "viaPrivate",
    ]);
  });
});
