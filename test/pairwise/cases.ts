// ---------------------------------------------------------------------------
// M-T9.29 — the pairwise-combination corpus: CASE SELECTION.
//
// Two different budgets, so two different case sets:
//
//   - The GENERATION oracle is an in-memory pipeline run — no compiler, no
//     database, ~30ms a case.  It gets the FULL cross product, because at that
//     price there is no reason to sample.
//   - The COMPILE and SCHEMA-LOAD oracles cost an `npm install` + `tsc`, or a
//     Postgres round-trip, per case.  They get an ALL-PAIRS (pairwise) cover:
//     the smallest set of tuples in which every value of every axis appears
//     together with every value of every other axis at least once.
//
// All-pairs is the right sample precisely because of what the bug class looks
// like: every recorded instance (#2412, #2387/#2391, #2492) is a TWO-factor
// interaction.  A cover that contains all pairs finds every such bug, and it
// does so in ~25 cases instead of 200.
// ---------------------------------------------------------------------------

import {
  AUTHZ,
  type Authz,
  CAPABILITIES,
  type Capability,
  type PairwiseCase,
  PERSISTENCE,
  PERSISTENCE_BACKEND,
  type Persistence,
  SHAPES,
  type Shape,
} from "./axes.js";

/** The persistence values reachable on a given backend — `default`, plus every
 *  non-default adapter whose home backend this is.  DERIVED from the one
 *  `PERSISTENCE_BACKEND` table rather than restated as a second `if` ladder, so
 *  adding an adapter to the axes cannot leave the cover blind to it. */
export function persistenceFor(platform: string): Persistence[] {
  return PERSISTENCE.filter(
    (p) => PERSISTENCE_BACKEND[p] === null || PERSISTENCE_BACKEND[p] === platform,
  );
}

type AxisValues = readonly (readonly string[])[];

/**
 * Greedy all-pairs (IPOG-style) cover over N axes.
 *
 * Deterministic: the candidate order is the natural axis order and ties break
 * toward the first candidate, so the same axes always yield the same case list.
 * A generated matrix that reshuffles between runs would make a CI shard index
 * meaningless and a findings register unciteable.
 */
export function allPairs(axes: AxisValues): number[][] {
  const n = axes.length;
  // Every (axisA, valueA, axisB, valueB) pair still uncovered.
  const remaining = new Set<string>();
  const pairKey = (i: number, vi: number, j: number, vj: number) => `${i}:${vi}|${j}:${vj}`;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let vi = 0; vi < axes[i]!.length; vi++) {
        for (let vj = 0; vj < axes[j]!.length; vj++) remaining.add(pairKey(i, vi, j, vj));
      }
    }
  }

  const rows: number[][] = [];
  while (remaining.size > 0) {
    // SEED the row with one still-uncovered pair, so every row is guaranteed
    // to make progress (and the loop is guaranteed to terminate).  Then fill
    // the remaining axes greedily, each with the value covering the most
    // uncovered pairs against the axes already fixed.  Seeding is what makes
    // this near-optimal: a purely greedy fill re-picks the same low-index
    // values row after row and needs ~2x the rows.
    const seed = remaining.values().next().value as string;
    const [sa, sb] = seed.split("|");
    const [ai, av] = sa!.split(":").map(Number);
    const [bi, bv] = sb!.split(":").map(Number);

    const row: number[] = new Array(n).fill(-1);
    row[ai!] = av!;
    row[bi!] = bv!;
    for (let i = 0; i < n; i++) {
      if (row[i] !== -1) continue;
      let best = 0;
      let bestScore = -1;
      for (let v = 0; v < axes[i]!.length; v++) {
        let score = 0;
        for (let j = 0; j < n; j++) {
          if (j === i || row[j] === -1) continue;
          const key = j < i ? pairKey(j, row[j]!, i, v) : pairKey(i, v, j, row[j]!);
          if (remaining.has(key)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          best = v;
        }
      }
      row[i] = best;
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) remaining.delete(pairKey(i, row[i]!, j, row[j]!));
    }
    rows.push(row);
  }
  return rows;
}

/** The all-pairs cover over capability × shape × authz × persistence, for one
 *  backend's reachable persistence menu.
 *
 *  `only` narrows the persistence axis — the schema-load oracle passes
 *  `["default"]` because only the raw-SQL adapters emit a `.sql` migration
 *  chain at all (MikroORM ships `db/entities.ts` and lets its own schema
 *  generator produce DDL at boot, so there is nothing for `psql -f` to read).
 *  Narrowing is the honest move: running those cases would assert "no chain
 *  emitted" as a failure of an adapter that never emits one. */
export function pairwiseCover(platform: string, only?: readonly Persistence[]): PairwiseCase[] {
  const persistence = only ? [...only] : persistenceFor(platform);
  const rows = allPairs([CAPABILITIES, SHAPES, AUTHZ, persistence]);
  return rows.map(([c, s, a, p]) => ({
    capability: CAPABILITIES[c!] as Capability,
    shape: SHAPES[s!] as Shape,
    authz: AUTHZ[a!] as Authz,
    persistence: persistence[p!] as Persistence,
  }));
}
