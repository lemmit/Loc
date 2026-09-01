import { describe, expect, it } from "vitest";
import type { EnrichedBoundedContextIR } from "../../../src/ir/types/loom-ir.js";
import { mergeContexts } from "../../../src/ir/util/merge-contexts.js";

// The union a multi-context backend deployable (hono / dotnet / python) emits
// its shared domain + schema from.  M-T9.17 slice 3 — no test imports this
// module directly.
//
// `test/ir/ir-merge-completeness.test.ts` already gates that every field of
// `BoundedContextIR` is CARRIED here (or listed as deliberately dropped).  That
// is a presence gate; it says nothing about the three fields whose merge is not
// a plain union, and those are precisely where the defects have been:
//
//   • ambient enums / value objects are DEDUPED by name — enrichment folds them
//     into every context, so a plain union emits `export const currencyEnum = …`
//     once per hosted context and the bundler rejects the file;
//   • `structuralErrorStatuses` is first-DEFINED wins;
//   • `errorStatusOverrides` is folded first-DECLARED wins, and stays
//     `undefined` (not `{}`) when no context declares any.
//
// The two error-status maps were MISSING from this merge entirely, and the
// consequence was invisible: an emitter fed the merged context read `undefined`
// for both, so every `httpStatus <Error> -> <Code>` override no-opped on that
// path while the same override moved the per-context emitters in the same
// generated app.  So each of those rules is asserted on its own here.

const EMPTY_LISTS = {
  events: [],
  payloads: [],
  aggregates: [],
  repositories: [],
  workflows: [],
  criteria: [],
  channels: [],
  retrievals: [],
  seeds: [],
  eventSubscriptions: [],
} as const;

const ctx = (over: Partial<EnrichedBoundedContextIR> = {}): EnrichedBoundedContextIR =>
  ({
    name: "C",
    enums: [],
    valueObjects: [],
    ...EMPTY_LISTS,
    ...over,
  }) as unknown as EnrichedBoundedContextIR;

const named = (name: string) => ({ name }) as never;

describe("mergeContexts — the plain-union fields", () => {
  it("concatenates aggregates from every context, in order", () => {
    const merged = mergeContexts([
      ctx({ aggregates: [named("Order")] }),
      ctx({ aggregates: [named("Invoice"), named("Line")] }),
    ]);
    expect(merged.aggregates.map((a) => a.name)).toEqual(["Order", "Invoice", "Line"]);
  });

  it("does NOT dedupe non-ambient members — two same-named aggregates both survive", () => {
    // Only enums and value objects are ambient (folded into every context by
    // enrichment).  Deduping an aggregate would silently drop a real
    // declaration from a second bounded context that happens to reuse a name.
    const merged = mergeContexts([
      ctx({ aggregates: [named("Order")] }),
      ctx({ aggregates: [named("Order")] }),
    ]);
    expect(merged.aggregates).toHaveLength(2);
  });

  it("takes the FIRST context's name (callers spread their own over it)", () => {
    expect(mergeContexts([ctx({ name: "Sales" }), ctx({ name: "Billing" })]).name).toBe("Sales");
  });

  it("names an empty merge 'merged' rather than throwing on an empty list", () => {
    const merged = mergeContexts([]);
    expect(merged.name).toBe("merged");
    expect(merged.aggregates).toEqual([]);
  });

  it("tolerates the OPTIONAL list fields being absent on a context", () => {
    // `domainServices` / `projections` / `tests` / `commandHandlers` /
    // `queryHandlers` are `?? []`-guarded: a context lowered without them must
    // merge to an empty list, not to `undefined` spread into a flatMap.
    const merged = mergeContexts([ctx(), ctx()]);
    expect(merged.domainServices).toEqual([]);
    expect(merged.projections).toEqual([]);
    expect(merged.tests).toEqual([]);
    expect(merged.commandHandlers).toEqual([]);
    expect(merged.queryHandlers).toEqual([]);
  });

  it("unions the application-layer handlers rather than deduping them", () => {
    const merged = mergeContexts([
      ctx({ commandHandlers: [named("PlaceOrder")], queryHandlers: [named("GetOrder")] }),
      ctx({ commandHandlers: [named("ShipOrder")] }),
    ]);
    expect(merged.commandHandlers.map((h) => h.name)).toEqual(["PlaceOrder", "ShipOrder"]);
    expect(merged.queryHandlers.map((h) => h.name)).toEqual(["GetOrder"]);
  });
});

describe("mergeContexts — the ambient dedupe (enums / value objects)", () => {
  it("collapses the SAME ambient enum folded into both contexts", () => {
    // The duplicate-emission bug: `export const currencyEnum = …` twice in one
    // file.  Both contexts carry it because enrichment folds root-level ambient
    // declarations into every context.
    const merged = mergeContexts([
      ctx({ enums: [named("Currency")] }),
      ctx({ enums: [named("Currency")] }),
    ]);
    expect(merged.enums.map((e) => e.name)).toEqual(["Currency"]);
  });

  it("keeps DISTINCT enums — dedupe is by name, not a truncation", () => {
    const merged = mergeContexts([
      ctx({ enums: [named("Currency"), named("Status")] }),
      ctx({ enums: [named("Currency"), named("Region")] }),
    ]);
    expect(merged.enums.map((e) => e.name)).toEqual(["Currency", "Status", "Region"]);
  });

  it("dedupes value objects too — the other ambient kind, asserted alone", () => {
    // Asserted separately from enums: a copy that deduped only `enums` would
    // still pass a test that supplied duplicates of both at once.
    const merged = mergeContexts([
      ctx({ valueObjects: [named("Money")] }),
      ctx({ valueObjects: [named("Money"), named("Address")] }),
    ]);
    expect(merged.valueObjects.map((v) => v.name)).toEqual(["Money", "Address"]);
  });
});

describe("mergeContexts — structuralErrorStatuses (first DEFINED wins)", () => {
  it("stays undefined when no context defines it", () => {
    expect(mergeContexts([ctx(), ctx()]).structuralErrorStatuses).toBeUndefined();
  });

  it("picks the first DEFINED map, skipping leading contexts that have none", () => {
    // `find(c => … !== undefined)`, not `contexts[0]`: the app-wide map is
    // attached during enrichment and a context may legitimately lack it.  A
    // `[0]`-indexed copy would read `undefined` and silently drop every
    // structural status override.
    const merged = mergeContexts([ctx(), ctx({ structuralErrorStatuses: { NotFound: 404 } })]);
    expect(merged.structuralErrorStatuses).toEqual({ NotFound: 404 });
  });

  it("does not merge the maps — the app-wide fold already made them identical", () => {
    const merged = mergeContexts([
      ctx({ structuralErrorStatuses: { NotFound: 404 } }),
      ctx({ structuralErrorStatuses: { Conflict: 409 } }),
    ]);
    expect(merged.structuralErrorStatuses).toEqual({ NotFound: 404 });
  });
});

describe("mergeContexts — errorStatusOverrides (folded, first DECLARED wins)", () => {
  it("stays UNDEFINED when no context declares any, rather than becoming {}", () => {
    // The two are equivalent to `resolveErrorStatus`, but an absent field keeps
    // a merged context byte-comparable with an unmerged one, which is what the
    // cross-backend identity assertions rest on.
    expect(mergeContexts([ctx(), ctx()]).errorStatusOverrides).toBeUndefined();
  });

  it("becomes {} — not undefined — when a context declares an EMPTY map", () => {
    // The distinction the `some(… !== undefined)` guard draws: declared-empty
    // is a different fact from never-declared.
    expect(mergeContexts([ctx({ errorStatusOverrides: {} })]).errorStatusOverrides).toEqual({});
  });

  it("unions overrides declared across different contexts", () => {
    const merged = mergeContexts([
      ctx({ errorStatusOverrides: { OutOfStock: 409 } }),
      ctx({ errorStatusOverrides: { Unpaid: 402 } }),
    ]);
    expect(merged.errorStatusOverrides).toEqual({ OutOfStock: 409, Unpaid: 402 });
  });

  it("resolves a CONFLICTING name to the FIRST-declared context's status", () => {
    // The tie-break, asserted on its own: it mirrors the app-wide
    // `structuralErrorStatuses` fold, so the two mechanisms cannot disagree
    // about which api won.  The reverse-loop implementation exists precisely to
    // get this direction (a naive `reduce` + spread gives LAST-declared wins,
    // and Biome rejects that shape anyway).
    const merged = mergeContexts([
      ctx({ errorStatusOverrides: { OutOfStock: 409 } }),
      ctx({ errorStatusOverrides: { OutOfStock: 422 } }),
    ]);
    expect(merged.errorStatusOverrides).toEqual({ OutOfStock: 409 });
  });

  it("keeps first-declared-wins across THREE contexts, not just a pair", () => {
    // Two contexts cannot distinguish "first wins" from "the earlier of the
    // two"; three can — the reverse loop must leave context 0 on top after
    // both later contexts have written.
    const merged = mergeContexts([
      ctx({ errorStatusOverrides: { E: 1 } }),
      ctx({ errorStatusOverrides: { E: 2 } }),
      ctx({ errorStatusOverrides: { E: 3, F: 9 } }),
    ]);
    expect(merged.errorStatusOverrides).toEqual({ E: 1, F: 9 });
  });

  it("fills from later contexts when an earlier one declares none", () => {
    const merged = mergeContexts([ctx(), ctx({ errorStatusOverrides: { Unpaid: 402 } })]);
    expect(merged.errorStatusOverrides).toEqual({ Unpaid: 402 });
  });
});
