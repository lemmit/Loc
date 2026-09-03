import { describe, expect, it } from "vitest";
import {
  AUTHZ,
  allSourceCases,
  CAPABILITIES,
  caseId,
  INHERITANCE,
  type PairwiseCase,
  PERSISTENCE,
  READS,
  SHAPES,
  type SourceCase,
} from "./axes.js";
import { allPairs, pairwiseCover, persistenceFor } from "./cases.js";
import { composeSource } from "./compose.js";
import { waiverFor } from "./waivers.js";

// ---------------------------------------------------------------------------
// The AXIS-SET invariants — the gate that widening the matrix has to pass.
//
// W3 added two axes (inheritance, read) to a matrix that three other oracles
// index by case ID and sample by all-pairs cover.  Both of those mechanisms can
// break SILENTLY when an axis is added, and a silent break here is the worst
// kind: the sweep keeps passing while covering less than it claims.
//
//   * the ID is built by OMITTING each axis's inert value, so the ids the
//     findings register already cites keep naming the same crossing.  That is
//     only sound if omission stays injective — and three axes have a value
//     spelled `none`, so it is not self-evident.
//   * the cover is generated, so nothing but a test can say it actually
//     contains every pair.  A cover that silently dropped an axis would still
//     produce cases, still compile, and still pass every downstream assertion.
//
// Both are asserted from the axis CONSTANTS rather than from a written-down
// expectation, so a future axis is covered by these tests the day it is added.
// ---------------------------------------------------------------------------

const ALL_AXES = [CAPABILITIES, SHAPES, AUTHZ, INHERITANCE, READS, PERSISTENCE] as const;

describe("case ids stay unique when inert axis values are omitted", () => {
  it("no two crossings share an id, across the FULL space", () => {
    const seen = new Map<string, PairwiseCase>();
    const collisions: string[] = [];
    for (const sc of allSourceCases()) {
      for (const persistence of PERSISTENCE) {
        const kase: PairwiseCase = { ...sc, persistence };
        const id = caseId(kase);
        const prior = seen.get(id);
        if (prior) collisions.push(`${id}: ${JSON.stringify(prior)} vs ${JSON.stringify(kase)}`);
        else seen.set(id, kase);
      }
    }
    expect(
      collisions,
      "two crossings that share a case id — the id is used as a temp-dir name, a " +
        "Postgres database name and the findings register's citation key, so a " +
        "collision silently merges two cases into one verdict.  Either the new " +
        "axis needs its inert value spelled out in the id, or its value set " +
        "overlaps another axis's.",
    ).toEqual([]);
    expect(seen.size).toBe(allSourceCases().length * PERSISTENCE.length);
  });

  it("a crossing with every axis inert keeps the id it had before the axes grew", () => {
    // The exact id the 2026-08 findings register cites in its F1 reproduce
    // command (`node-none-document-policyAllow-default.ddd`).  This is the
    // property the omission rule exists for; without it, widening the matrix
    // would silently invalidate every citation in the audit doc.
    expect(
      caseId({
        capability: "none",
        shape: "document",
        authz: "policyAllow",
        inheritance: "none",
        read: "plain",
        persistence: "default",
      }),
    ).toBe("none-document-policyAllow-default");
  });

  it("a non-inert value of a new axis DOES appear in the id", () => {
    const base = {
      capability: "none",
      shape: "document",
      authz: "policyAllow",
      persistence: "default",
    } as const;
    expect(caseId({ ...base, inheritance: "tph", read: "plain" })).toContain("-tph-");
    expect(caseId({ ...base, inheritance: "none", read: "paged" })).toContain("-paged-");
  });
});

describe("the all-pairs cover really contains every pair", () => {
  // `allPairs` is a greedy heuristic.  Greedy heuristics are exactly the kind of
  // code that keeps working after it stops being correct — a fill that skipped
  // the last axis would still return rows, and every consumer would still run.
  // So the property is checked directly, on the shape the cover is actually
  // used at: the six-axis set, per backend.
  for (const platform of ["node", "dotnet", "elixir"]) {
    it(`covers every 2-way combination on ${platform}`, () => {
      const persistence = persistenceFor(platform);
      const axes = [CAPABILITIES, SHAPES, AUTHZ, INHERITANCE, READS, persistence];
      const cover = pairwiseCover(platform);
      const rows = cover.map((c) => [
        c.capability,
        c.shape,
        c.authz,
        c.inheritance,
        c.read,
        c.persistence,
      ]);

      const missing: string[] = [];
      for (let i = 0; i < axes.length; i++) {
        for (let j = i + 1; j < axes.length; j++) {
          for (const vi of axes[i]!) {
            for (const vj of axes[j]!) {
              if (!rows.some((r) => r[i] === vi && r[j] === vj)) missing.push(`${vi}×${vj}`);
            }
          }
        }
      }
      expect(missing, "axis-value pairs no cover row contains").toEqual([]);
    });
  }

  it("is deterministic — the same axes always yield the same rows", () => {
    // A cover that reshuffles between runs makes a CI shard index meaningless
    // and a findings-register id unciteable.
    expect(pairwiseCover("node").map(caseId)).toEqual(pairwiseCover("node").map(caseId));
  });

  it("stays a SAMPLE — adding axes must not collapse it into the cross product", () => {
    // The trade this slice claims: the axes multiply, the sample does not.  The
    // cover is bounded below by the largest pair product (5×5 = 25) and must
    // stay near it, well under the 200 full crossings for one backend.
    const cover = pairwiseCover("node");
    expect(cover.length).toBeGreaterThanOrEqual(25);
    expect(cover.length).toBeLessThan(60);
  });

  it("allPairs terminates and covers a degenerate single-value axis", () => {
    const rows = allPairs([["a", "b"], ["x"], ["p", "q", "r"]]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const v of ["a", "b"]) {
      for (const w of ["p", "q", "r"]) {
        expect(
          rows.some((r) => r[0] === ["a", "b"].indexOf(v) && r[2] === ["p", "q", "r"].indexOf(w)),
        ).toBe(true);
      }
    }
  });
});

describe("the composer actually varies with the new axes", () => {
  // A composer that ignored an axis would leave every assertion above green and
  // every downstream oracle running the SAME source under N different names —
  // the vacuous-gate shape this corpus exists to avoid (§59/§63).  So each new
  // axis is pinned to the source text it is supposed to produce.
  const base: SourceCase = {
    capability: "none",
    shape: "relational",
    authz: "none",
    inheritance: "none",
    read: "plain",
  };

  it("inheritance=none declares no base type at all", () => {
    const src = composeSource(base);
    expect(src).not.toContain("abstract aggregate");
    expect(src).not.toContain("extends");
  });

  it("inheritance=tph emits a sharedTable base the subject extends", () => {
    const src = composeSource({ ...base, inheritance: "tph" });
    expect(src).toContain("abstract aggregate ThingBase inheritanceUsing: sharedTable");
    expect(src).toContain("aggregate Thing extends ThingBase");
  });

  it("inheritance=tpc emits an ownTable base the subject extends", () => {
    const src = composeSource({ ...base, inheritance: "tpc" });
    expect(src).toContain("abstract aggregate ThingBase inheritanceUsing: ownTable");
    expect(src).toContain("aggregate Thing extends ThingBase");
  });

  it("the extends clause survives the header modifiers it sits beside", () => {
    // `extends` occupies the grammar slot between the name and the
    // order-independent modifier group, so a header value must not displace it.
    const src = composeSource({
      ...base,
      inheritance: "tph",
      shape: "document",
      capability: "audited",
    });
    expect(src).toContain(
      "aggregate Thing extends ThingBase shape: document, inheritanceUsing: ownTable, audited",
    );
  });

  // The two MEASURED adjustments — each one exists because the first run of the
  // widened matrix spent hundreds of crossings bouncing off a named diagnostic
  // instead of reaching an emitter.  Pinned so a later edit cannot quietly put
  // those crossings back on the validator floor: the sweep would stay green
  // (a rejection is a legitimate verdict) while covering a sixth less.
  it("a document/eventLog concrete of a TPH base declares the FORCED ownTable", () => {
    for (const shape of ["document", "eventLog"] as const) {
      const src = composeSource({ ...base, inheritance: "tph", shape });
      expect(src, `${shape} × tph`).toContain("inheritanceUsing: ownTable");
      // …while the BASE keeps its sharedTable, so tph and tpc stay different.
      expect(src).toContain("abstract aggregate ThingBase inheritanceUsing: sharedTable");
    }
  });

  it("a relational/embedded concrete of a TPH base does NOT override the layout", () => {
    for (const shape of ["relational", "embedded"] as const) {
      expect(composeSource({ ...base, inheritance: "tph", shape }), `${shape} × tph`).not.toContain(
        "inheritanceUsing: ownTable",
      );
    }
  });

  it("an event-sourced subject under inheritance gets the base's state dataSource", () => {
    for (const inheritance of ["tph", "tpc"] as const) {
      const src = composeSource({ ...base, inheritance, shape: "eventLog" });
      expect(src, `${inheritance}`).toContain("resource mainBase { for: Main, kind: state");
      expect(src).toContain("dataSources: [mainState, mainBase]");
    }
    // Without a base there is nothing state-persisted, so no second resource.
    const flat = composeSource({ ...base, shape: "eventLog" });
    expect(flat).not.toContain("mainBase");
  });

  it("read=plain returns the bare list, read=paged returns the carrier", () => {
    expect(composeSource(base)).toContain("find byLabel(l: string): Thing[] where");
    expect(composeSource({ ...base, read: "paged" })).toContain(
      "find byLabel(l: string): Thing paged where",
    );
  });

  it("every crossing composes a DISTINCT source text", () => {
    // The strongest form of the above: no two of the 600 source cases may
    // produce identical `.ddd`.  An axis silently dropped from the composer
    // fails here even if nothing pins its individual syntax.
    const byText = new Map<string, SourceCase>();
    const dupes: string[] = [];
    for (const sc of allSourceCases()) {
      const src = composeSource(sc);
      const prior = byText.get(src);
      if (prior) dupes.push(`${JSON.stringify(prior)} == ${JSON.stringify(sc)}`);
      else byText.set(src, sc);
    }
    expect(dupes, "distinct axis tuples that compose byte-identical source").toEqual([]);
  });
});

describe("a waiver cannot silently widen across the new axes", () => {
  // The hazard this pins is specific and was live the moment the axes landed:
  // `waiverFor` matches field by field, so an axis it does not read is an axis
  // every waiver implicitly stars.  An entry written for `embedded × tph` would
  // then also cover `embedded × tpc` and flat `embedded` — and the stale-waiver
  // ratchet CANNOT catch that, because the entry keeps matching something.
  // A widened waiver is invisible in both gate directions; only this is left.
  const W = {
    platform: "node",
    persistence: "*",
    capability: "*",
    shape: "embedded",
    authz: "*",
    inheritance: "tph",
    read: "*",
    reason: "test",
  } as const;
  const kase = (over: Partial<PairwiseCase>): PairwiseCase => ({
    capability: "none",
    shape: "embedded",
    authz: "none",
    inheritance: "tph",
    read: "plain",
    persistence: "default",
    ...over,
  });

  it("matches the crossing it names", () => {
    expect(waiverFor([W], kase({}), "node")).toBeDefined();
  });

  it("does NOT match the sibling inheritance layout", () => {
    expect(waiverFor([W], kase({ inheritance: "tpc" }), "node")).toBeUndefined();
    expect(waiverFor([W], kase({ inheritance: "none" }), "node")).toBeUndefined();
  });

  it("does NOT match a different read carrier when the axis is pinned", () => {
    const pinned = { ...W, read: "paged" } as const;
    expect(waiverFor([pinned], kase({ read: "plain" }), "node")).toBeUndefined();
    expect(waiverFor([pinned], kase({ read: "paged" }), "node")).toBeDefined();
  });

  it("`*` on a new axis still matches every value of it", () => {
    for (const inheritance of INHERITANCE) {
      expect(waiverFor([{ ...W, inheritance: "*" }], kase({ inheritance }), "node")).toBeDefined();
    }
  });
});

describe("the axis set is wired end to end", () => {
  it("every axis constant is reachable from a composed case", () => {
    // A new axis added to `axes.ts` but never threaded into `allSourceCases`
    // would leave the matrix exactly as wide as before while the file claims
    // otherwise.  Count-checked rather than eyeballed.
    const expected =
      CAPABILITIES.length * SHAPES.length * AUTHZ.length * INHERITANCE.length * READS.length;
    expect(allSourceCases().length).toBe(expected);
    expect(ALL_AXES.every((a) => a.length > 0)).toBe(true);
  });
});
