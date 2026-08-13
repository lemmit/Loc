// Which of the language's clauses does the fixture corpus actually contain?
//
// Retro §82 is this gate's origin story. Shipping ICU interpolation on Phoenix
// added a generated CLDR backend, two hex deps and an `import` into every
// template — all of it Elixir the toolchain emits but never itself compiles. A
// hand-written 15-line census answered the question the green board could not:
// the 40 corpus fixtures carry **no `ui` block at all**, and none of the four
// Elixir-targeting examples interpolated. The feature would have merged with
// ZERO compile coverage, and the first person to find out would have been a
// user. Every gate passed; every gate was blind, because the emission is
// conditional and no gated input satisfied its condition.
//
// That census has now been re-derived by hand three times in six days. This is
// it, standing and ratcheting: a tally of every AST node type the tracked
// `.ddd` corpus instantiates, and an exact-set register of the ones it never
// does. "Some gate covers this area" stops being an assumption you can hold
// without evidence.
//
// WHAT IT MEASURES, precisely: the surface fixtures AUTHOR, from a raw parse —
// not the surface the pipeline eventually sees. A macro-expanded model contains
// far more (every `with scaffold(...)` synthesizes pages, areas and menus), and
// that is the point: a clause reachable ONLY through expansion has no
// hand-written witness, so the emit path a human would take is unexercised.
//
// The population of "clauses" is DERIVED from Langium's own reflection —
// `getAllSubTypes(t) === [t]` is the concrete/instantiable test — so a new
// grammar rule enters this census automatically. Nothing to remember to add.
//
// MUTATION-PROVED: deleting the `join` clause from the projection fixture that
// this PR adds returns `ProjectionJoin` to the zero register and fails the
// ratchet by name; the walker itself is guarded by the population assertions
// below (it under-counted catastrophically in development — see the cycle note
// on `tallyAstTypes`).

import { EmptyFileSystem } from "langium";
import { describe, expect, it } from "vitest";
import { createDddServices } from "../../src/language/ddd-module.js";
import { reflection } from "../../src/language/generated/ast.js";
import { UNPARSEABLE_DDD, dddSourceOf, trackedDddFiles } from "../_helpers/ddd-corpus.js";

const parser = createDddServices(EmptyFileSystem).Ddd.parser.LangiumParser;

/** Count every `$type` in one parsed document.
 *
 *  The `visited` set is load-bearing, not defensive: a Langium AST is cyclic
 *  (`$container` is skipped by the `$`-prefix rule, but cross-references and
 *  shared nodes are not), and the first draft of this walk without it blew the
 *  stack on nearly every file — inside a `try/catch` that swallowed it, so the
 *  census reported a plausible-looking 100 types instead of 182. A sweep that
 *  silently under-counts is exactly the failure this gate exists to prevent,
 *  which is why the population assertions below are not optional. */
function tallyAstTypes(root: unknown, into: Map<string, number>): void {
  const visited = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (!n || typeof n !== "object" || visited.has(n)) return;
    visited.add(n);
    const rec = n as Record<string, unknown>;
    if (typeof rec.$type === "string") into.set(rec.$type, (into.get(rec.$type) ?? 0) + 1);
    for (const [k, v] of Object.entries(rec)) {
      if (k.startsWith("$")) continue;
      if (Array.isArray(v)) for (const el of v) walk(el);
      else if (v && typeof v === "object") walk(v);
    }
  };
  walk(root);
}

/** Every AST type the grammar can actually INSTANTIATE. Langium generates an
 *  interface for each rule union too (`Statement`, `Expression`, `ModelMember`,
 *  …); those never appear as a `$type`, so counting them as "unexercised" would
 *  bury the real gaps under 30 lines of noise. `getAllSubTypes(t) === [t]` is
 *  the discriminator, taken from reflection rather than a hand-kept list. */
function concreteAstTypes(): string[] {
  return reflection
    .getAllTypes()
    .filter((t) => {
      const subs = reflection.getAllSubTypes(t);
      return subs.length === 1 && subs[0] === t;
    })
    .sort();
}

/** `path → { type → count }`, one entry per tracked, parseable `.ddd`. */
function censusByFile(): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const file of trackedDddFiles()) {
    if (file === UNPARSEABLE_DDD) continue;
    const counts = new Map<string, number>();
    tallyAstTypes(parser.parse(dddSourceOf(file)).value, counts);
    out.set(file, counts);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The register: clauses the grammar accepts that NO tracked `.ddd` authors.
//
// Each is a feature whose hand-written emit path has no witness anywhere — the
// §82 shape. Entries leave by gaining a fixture, not by being deleted.
// ---------------------------------------------------------------------------
const UNAUTHORED_CLAUSES: Record<string, string> = {
  // `area X { page … }` — the page-grouping clause, whose contained pages emit
  // to `src/pages/<area-path>/<page>.tsx` (the path joins down the nesting) and
  // which may nest sub-areas (`AreaMember: Page | Area`). Every area in the
  // repo is SYNTHESIZED by `with scaffold(...)`, so the hand-authored form —
  // and nesting in particular, which scaffold never produces — is emitted by
  // nothing anyone has compiled.
  Area: "no fixture authors an `area` block; every one in the repo comes from scaffold expansion",
  // Macro arguments of int / string kind. The stdlib macros in use take bools
  // and refs (`crudish(updateOnly: true)`, `scaffold(aggregates: [X])`), so the
  // two literal arms of `MacroArgValue` have never been parsed from a fixture.
  MacroArgInt: "no fixture passes an INT macro argument (`with m(n: 2)`)",
  MacroArgString: "no fixture passes a STRING macro argument (`with m(s: \"x\")`)",
};

describe("clause census — what the corpus authors, and what it never does", () => {
  const byFile = censusByFile();
  const totals = new Map<string, number>();
  for (const counts of byFile.values()) {
    for (const [t, n] of counts) totals.set(t, (totals.get(t) ?? 0) + n);
  }
  const concrete = concreteAstTypes();

  it("counts a whole, plausible population (a silent under-count would pass everything)", () => {
    // The walker's failure mode is under-counting, and an under-count makes
    // every "unexercised" claim below unfalsifiable. These pin the shape of a
    // healthy census: ~340 files, ~186 instantiable types, the great majority
    // of them actually instantiated.
    expect(byFile.size).toBeGreaterThan(300);
    expect(concrete.length).toBeGreaterThan(150);
    expect(totals.size).toBeGreaterThan(150);
    // Spot-check three types that must appear in ANY healthy parse of this
    // corpus — if the walk breaks, these go to zero first.
    for (const t of ["Aggregate", "Operation", "Deployable"]) {
      expect(totals.get(t) ?? 0, `no ${t} counted — the walk is broken`).toBeGreaterThan(50);
    }
  });

  it("registers every clause no fixture authors — exactly", () => {
    const unauthored = concrete.filter((t) => !totals.has(t)).sort();
    expect(
      unauthored,
      "the set of NEVER-AUTHORED clauses changed. A new entry means a language " +
        "feature whose hand-written form no fixture exercises — write the fixture, or " +
        "add it to UNAUTHORED_CLAUSES with the reason. A disappeared entry means a " +
        "fixture now covers it: delete its entry (the register ratchets).",
    ).toEqual(Object.keys(UNAUTHORED_CLAUSES).sort());
  });

  it("the elixir compile gate reads at least one fixture with a `ui` (retro §82)", () => {
    // The regression guard for §82 itself. `elixir-vanilla-build.yml` enumerates
    // its fixture directory dynamically, and the whole finding was that NO input
    // it reads carried a `ui` — so every frontend-conditional emission (the CLDR
    // backend, `loom_icu/2`, the `import` into html_helpers) compiled nowhere.
    // One fixture fixed it; this keeps it fixed.
    const elixirFixtures = [...byFile.entries()].filter(([f]) =>
      f.startsWith("test/e2e/fixtures/elixir-vanilla-build/"),
    );
    expect(elixirFixtures.length).toBeGreaterThan(10);
    const withUi = elixirFixtures.filter(([, counts]) => (counts.get("Ui") ?? 0) > 0);
    expect(
      withUi.length,
      "no fixture the elixir compile gate reads declares a `ui` — every " +
        "frontend-conditional emission on Phoenix (HEEx pages, the i18n runtime) would " +
        "compile in no CI job at all. This is retro §82, exactly.",
    ).toBeGreaterThan(0);
  });

  it("the corpus fixtures still carry no `ui` — the other half of §82, stated", () => {
    // NOT a defect, and recorded so nobody re-derives it a fourth time: the
    // corpus is a BACKEND feature matrix, so `corpus-elixir-build` can never
    // reach a frontend feature no matter how many fixtures it gains. Anyone
    // adding a frontend-conditional emission needs an `elixir-vanilla-build`
    // fixture (above), not a corpus one. If this ever flips, the comment is
    // wrong rather than the code — read it before deleting the assertion.
    const corpus = [...byFile.entries()].filter(([f]) =>
      f.startsWith("test/fixtures/corpus/"),
    );
    expect(corpus.length).toBeGreaterThan(30);
    const withUi = corpus.filter(([, c]) => (c.get("Ui") ?? 0) > 0).map(([f]) => f);
    expect(withUi).toEqual([]);
  });
});
