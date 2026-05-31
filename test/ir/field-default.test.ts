// First-class field default values — `field: T = <expr>`.
//
// Phase 1: the default expression lowers onto `FieldIR.default` (a
// fully-resolved ExprIR) for the constructible declarations (aggregate,
// entity part, value object).  No codegen consumes it yet; this pins the
// lowering so the create-synthesis phase has a resolved default to read.

import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/index.js";
import { buildLoomModel } from "../_helpers/ir.js";

function aggOf(ir: Awaited<ReturnType<typeof buildLoomModel>>, name: string): AggregateIR {
  for (const s of ir.systems)
    for (const m of s.subdomains)
      for (const c of m.contexts) for (const a of c.aggregates) if (a.name === name) return a;
  throw new Error(`aggregate ${name} not found`);
}

const SRC = `
system S {
  subdomain M { context C {
    enum Status { Draft, Done }
    aggregate Article {
      headline: string
      status: Status = Draft
      rank: int = 0
      pinned: bool = false
    }
    repository Articles for Article { }
  }}
}
`;

describe("field default values lower onto FieldIR.default", () => {
  it("lowers literal + enum-value defaults; leaves undefaulted fields bare", async () => {
    const ir = await buildLoomModel(SRC);
    const agg = aggOf(ir, "Article");
    const byName = Object.fromEntries(agg.fields.map((f) => [f.name, f]));

    // No default declared → no `default` on the FieldIR.
    expect(byName.headline.default).toBeUndefined();

    // int / bool literal defaults resolve to ExprIR nodes.
    expect(byName.rank.default).toBeDefined();
    expect(byName.pinned.default).toBeDefined();

    // enum-value default resolves through name resolution (not a bare,
    // unresolved name) — the create-synthesis phase needs it typed.
    const statusDefault = byName.status.default;
    expect(statusDefault).toBeDefined();
    expect(typeof statusDefault?.kind).toBe("string");
  });

  it("rejects a default whose type doesn't match the field", async () => {
    const { errors } = await parseString(
      `system S { subdomain M { context C {
        aggregate A { n: int = "oops" }
        repository As for A { }
      }}}`,
    );
    expect(errors.join("\n")).toMatch(
      /Default for 'n' has type 'string' but the field is declared 'int'/,
    );
  });
});
