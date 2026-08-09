// Every private helper the vanilla-Phoenix emitter defines must be CALLED in
// the module that defines it — across the whole corpus.
//
// This is a cheap static stand-in for a gate that already exists but is
// expensive and late: `corpus-elixir-build.yml` compiles each fixture with
// `mix compile --warnings-as-errors`, and Elixir warns on an unused `defp`. So
// an unused helper is already a hard failure — it just costs a docker pull, a
// hex fetch and ~60s per feature to discover, on a workflow that only runs in
// CI.
//
// It caught a real regression the moment it existed. RS-28 moved the
// `none`-absent union find off `problem_variant/5` onto
// `ProblemDetails.problem_response/4` (so its 404 detail names the resource
// instead of degrading to the bare status phrase "Not Found"). But the
// predicate gating the HELPER's emission — `aggregateHasUnionFind` — still
// answered true for ANY union find. An aggregate whose only union find is
// `T option`, with no error-returning operation, then emitted the private
// helper unused, and `corpus-elixir` went red on `api-call`.
//
// The interesting part is that the sibling predicate for the OPERATION half,
// `aggregateHasReturningOpError`, already carried a doc-comment naming this
// exact hazard — "keeps it from being emitted-but-unused, which trips
// `mix compile --warnings-as-errors`". The find half had the looser predicate
// only because, until RS-28, every union find did call the responder. A
// documented hazard on one branch of a fork is not a gate on the other.
//
// Deliberately corpus-wide rather than one fixture: the failure needs a
// specific SHAPE (an aggregate reaching one helper-emitting condition but no
// call site), and which fixture happens to have that shape changes as fixtures
// evolve.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateSystemFiles } from "../../_helpers/generate.js";
import { CORPUS } from "../../fixtures/corpus/manifest.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));

/** Private helpers the emitter renders conditionally, i.e. the ones with a
 *  gating predicate that can disagree with the call sites. An unconditional
 *  helper cannot exhibit this bug. */
const CONDITIONAL_HELPERS = ["problem_variant"] as const;

describe("vanilla Phoenix — no emitted private helper is unused", () => {
  it("every conditionally-emitted defp has a call site in its own module", async () => {
    const offenders: string[] = [];
    let scanned = 0;

    for (const feature of CORPUS) {
      // The corpus manifest names the Elixir backend `vanilla`, not `elixir`.
      if (!feature.backends.includes("vanilla")) continue;
      let src: string;
      try {
        src = readFileSync(`${root}test/fixtures/corpus/${feature.id}.ddd`, "utf8");
      } catch {
        continue;
      }
      scanned++;
      const files = await generateSystemFiles(src.replace(/__PLATFORM__/g, "elixir"));
      for (const [path, body] of files) {
        if (!path.endsWith(".ex")) continue;
        for (const helper of CONDITIONAL_HELPERS) {
          // Count call sites as (all occurrences) − (definitions): the call
          // forms differ too much for one pattern (`  problem_variant(conn, …)`
          // on its own line vs `do: problem_variant(conn, …)` as a one-liner
          // body), and an earlier draft that matched only the first form
          // reported a false positive on `operation-returns`.
          const defs = (body.match(new RegExp(`defp ${helper}\\(`, "g")) ?? []).length;
          const all = (body.match(new RegExp(`${helper}\\(`, "g")) ?? []).length;
          if (defs > 0 && all <= defs) offenders.push(`${feature.id}: ${helper} in ${path}`);
        }
      }
    }

    expect(scanned, "scanned no corpus fixtures — the manifest filter has drifted").toBeGreaterThan(
      10,
    );
    expect(
      offenders,
      "an emitted private helper has no call site in its module. Elixir warns on an " +
        "unused defp, so `mix compile --warnings-as-errors` fails on this — narrow " +
        "the predicate that gates the helper's emission to match the conditions that " +
        "actually produce a call.",
    ).toEqual([]);
  }, 600_000);
});
