import { describe, expect, it } from "vitest";
import type { AggregateIR } from "../../../src/ir/types/loom-ir.js";
import {
  aggregatesHaveUniqueKeys,
  aggregatesNeedConcurrency,
} from "../../../src/ir/util/aggregate-flags.js";

// Presence gates: every backend orchestrator asks these two booleans before
// emitting its optimistic-concurrency machinery (the 409 arm, the conflict
// error class) and its unique-violation handling.  A false negative silently
// drops the 409 path from a project that needs it; a false positive breaks the
// byte-identical guarantee for a project that does not.  M-T9.17 slice 2 — no
// direct test.
//
// The composition is the interesting part: `versioned` OR `event-sourced` ⇒
// concurrency, because an event-log append hits the same stale-write conflict
// on a `(stream_id, version)` collision.  That rule was hand-inlined in five
// backends before it was factored here, so each disjunct is asserted ALONE —
// a copy that kept only the `versioned` half would still pass a test that only
// ever supplies both.

const agg = (over: Partial<AggregateIR> = {}): AggregateIR =>
  ({
    name: "Order",
    capabilities: [],
    persistedAs: "state",
    uniqueKeys: [],
    ...over,
  }) as unknown as AggregateIR;

const versioned = agg({ capabilities: ["versioned"] } as Partial<AggregateIR>);
const eventSourced = agg({ persistedAs: "eventLog" } as Partial<AggregateIR>);
const plain = agg();

describe("aggregatesNeedConcurrency", () => {
  it("is false for an empty set", () => {
    expect(aggregatesNeedConcurrency([])).toBe(false);
  });

  it("is false when no aggregate is versioned or event-sourced", () => {
    expect(aggregatesNeedConcurrency([plain, plain])).toBe(false);
  });

  it("is true on the VERSIONED disjunct alone", () => {
    expect(aggregatesNeedConcurrency([versioned])).toBe(true);
  });

  it("is true on the EVENT-SOURCED disjunct alone", () => {
    // The half a `versioned`-only copy would drop: an event-log append raises
    // the same conflict, so the 409 machinery is still required.
    expect(aggregatesNeedConcurrency([eventSourced])).toBe(true);
  });

  it("is a `some`, not an `every` — one qualifying aggregate is enough", () => {
    expect(aggregatesNeedConcurrency([plain, plain, versioned])).toBe(true);
    expect(aggregatesNeedConcurrency([eventSourced, plain])).toBe(true);
  });
});

describe("aggregatesHaveUniqueKeys", () => {
  it("is false for an empty set, and for aggregates with no unique keys", () => {
    expect(aggregatesHaveUniqueKeys([])).toBe(false);
    expect(aggregatesHaveUniqueKeys([plain, plain])).toBe(false);
  });

  it("treats an EMPTY uniqueKeys array as no unique keys", () => {
    // `(a.uniqueKeys?.length ?? 0) > 0` — the length check, not mere presence.
    // A truthiness test on the array itself would call `[]` a unique key.
    expect(aggregatesHaveUniqueKeys([agg({ uniqueKeys: [] } as Partial<AggregateIR>)])).toBe(false);
  });

  it("treats a MISSING uniqueKeys field as no unique keys", () => {
    const noField = {
      name: "Order",
      capabilities: [],
      persistedAs: "state",
    } as unknown as AggregateIR;
    expect(aggregatesHaveUniqueKeys([noField])).toBe(false);
  });

  it("is true when some aggregate declares one", () => {
    const keyed = agg({
      uniqueKeys: [{ fields: ["code"] }],
    } as unknown as Partial<AggregateIR>);
    expect(aggregatesHaveUniqueKeys([keyed])).toBe(true);
    expect(aggregatesHaveUniqueKeys([plain, keyed])).toBe(true);
  });
});
