// A macro-built projection must lower to the SAME IR as the identical
// hand-written one.
//
// The macro expander runs at the IndexedContent phase, BEFORE Langium's linker,
// and its `makeRef` produces a lenient reference (`$refText`, no resolution
// machinery) on the documented contract that lowering reads `$refText`
// directly.  Projection lowering did not: it read `p.source?.ref` only, so a
// scaffolded projection's source never resolved, `candidateAlias` was never
// bound, and a bare `o` never became `this`.
//
// The consequence was not cosmetic.  `o.total` lowered to a member on an
// UNRESOLVED ref instead of a member on `this`, so every consumer reasoning
// about source-column shape disagreed with the emitters — which is how
// `loom.projection-aggregate-arg-not-columnar` came to reject
// `scaffoldDashboard`'s own `sum(o.total)` and broke `main`
// (experience_gathered §70).
//
// This pins the invariant rather than any one symptom: two front ends produce
// IR, and they must produce the same one.

import { describe, expect, it } from "vitest";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel } from "../../src/ir/lower/lower.js";
import { allContexts, type ExprIR } from "../../src/ir/types/loom-ir.js";
import { parseString } from "../_helpers/parse.js";

async function aggregateArg(src: string, projection: string): Promise<ExprIR> {
  const { model } = await parseString(src, { validate: false });
  const loom = enrichLoomModel(lowerModel(model));
  const ctx = allContexts(loom).find((c) => c.name === "Orders");
  const proj = ctx?.projections.find((p) => p.name === projection);
  const select = proj?.query?.selects?.find((s) => !!s.aggregate?.arg);
  if (!select?.aggregate?.arg) throw new Error(`no aggregate arg on ${projection}`);
  return select.aggregate.arg;
}

/** `scaffoldDashboard` synthesises `projection OrderTotals { … sum(o.total) }`. */
const MACRO_BUILT = `system S { subdomain D { context Orders with scaffoldDashboard {
  aggregate Order { code: string  total: money }
  repository Orders for Order { } } } }`;

/** The same projection, written by hand. */
const HAND_WRITTEN = `system S { subdomain D { context Orders {
  aggregate Order { code: string  total: money }
  repository Orders for Order { }
  projection Hand { totalSum: money
    from Order as o
    select totalSum = sum(o.total) } } } }`;

describe("macro-built and parsed projections lower identically", () => {
  it("resolves the source alias in BOTH, so `o.total` is a member on `this`", async () => {
    const macro = await aggregateArg(MACRO_BUILT, "OrderTotals");
    const hand = await aggregateArg(HAND_WRITTEN, "Hand");

    expect(macro.kind).toBe("member");
    expect(hand.kind).toBe("member");
    if (macro.kind !== "member" || hand.kind !== "member") return;

    // The receiver is the whole point: an unresolved alias lowers to a `ref`,
    // a resolved one to `this`.  They must agree, and they must be `this`.
    expect(macro.receiver.kind).toBe(hand.receiver.kind);
    expect(macro.receiver.kind).toBe("this");
    expect(macro.member).toBe(hand.member);
    expect(macro.member).toBe("total");
  });
});
