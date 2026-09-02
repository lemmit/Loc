// The pipeline never throws on a VALID model it has never seen (M-T9.22, slice 1).
//
// Every other gate here drives the compiler with a FIXED list — the corpus, the
// examples, the behavioral systems. Those prove it handles the models someone
// wrote. This one asks the question the list cannot: does it handle the models
// nobody wrote?
//
// The invariant is the mission's: **a crash on valid input is always a bug** —
// either a missing validator gate (the model should have been rejected) or an
// emitter hole (it should have been emitted). Both are silent today: a thrown
// generator reaches a user as a stack trace from inside `ddd generate`, and the
// corpus only ever reaches the shapes it happens to contain.
//
// Deterministic: a seeded PRNG, a fixed seed range, no `Math.random` anywhere,
// so this cannot flake and any failure reproduces from its seed alone. The
// failure message carries the seed AND the generated source — the repro fixture
// is the output, not an exercise for the reader (the mission's "every failure
// ships with its seed for a deterministic repro fixture that graduates into the
// corpus").
//
// Seeds are spread across all five backends rather than run on each: the
// pipeline through phase ⑦ is shared, and the per-backend emitters are what the
// spread samples. 250 seeds × 1 backend each ≈ 12s, which is the whole budget
// this deserves in the fast suite; the depth belongs in a nightly with a much
// larger range (the mission's shrinking/expanded form).
//
// RELATION TO THE PAIRWISE HARNESS (M-T9.29, #2512), which hunts the same class
// by the opposite method: it composes a SYSTEMATIC matrix over curated axes
// (capability x storage shape x authz x persistence adapter) and found four live
// codegen throws on its first run — `shape: document` x `policy { allow … }`
// among them.  Those shapes are outside THIS generator's grammar subset, which
// is exactly why it found none of them: a curated axis list beats random
// sampling wherever someone already knows which crossings are load-bearing.
// What random generation adds is the region nobody curated — and the seed
// -> repro story.  The two are complements, and the productive way to grow this
// one is to teach it the axes #2512 proved were worth crossing.
//
// MUTATION-PROVED, because a gate that finds nothing on its first run proves
// nothing: seeding a throw into the shared `TypeIR` dispatcher's `optional` arm
// (reachable only from a model carrying an optional field) failed 156 of 250
// seeds across four backends; removing it returned the run to zero.

import { describe, expect, it } from "vitest";
import { genModel } from "../_helpers/ddd-model-generator.js";
import { generateSystemFiles } from "../_helpers/generate.js";
import { parseString } from "../_helpers/parse.js";

/** Seeds 1..N. Bounded for the fast suite; a nightly can raise it without
 *  changing anything else, because the generator is a pure function of seed. */
const SEEDS = 250;

/** Backends the seeds are spread across — `deployable.platform` is the only
 *  axis the generator does not vary itself. */
const PLATFORMS = ["node", "python", "java", "dotnet", "elixir"] as const;

const platformFor = (seed: number): string => PLATFORMS[seed % PLATFORMS.length] as string;

describe("pipeline fuzz — a crash on a valid model is always a bug", () => {
  it("generates, validates and emits every seeded model without throwing", async () => {
    const invalid: string[] = [];
    const crashed: string[] = [];

    for (let seed = 1; seed <= SEEDS; seed++) {
      const platform = platformFor(seed);
      const source = genModel(seed).replaceAll("__PLATFORM__", platform);
      try {
        // (1) The model must BE valid — otherwise the run below proves nothing
        // about behaviour on valid input. A failure here is a GENERATOR bug and
        // is reported as loudly as a compiler one, because a generator that
        // quietly emits invalid models turns this gate into noise.
        const parsed = await parseString(source, { validate: true });
        if (parsed.errors.length > 0) {
          invalid.push(`seed ${seed} [${platform}]: ${parsed.errors[0]}\n${source}`);
          continue;
        }
        // (2) …and the whole pipeline through codegen must not throw.
        await generateSystemFiles(source);
      } catch (e) {
        crashed.push(`seed ${seed} [${platform}]: ${(e as Error).message}\n${source}`);
      }
    }

    expect(
      invalid.slice(0, 2),
      "the GENERATOR emitted an invalid model — fix `test/_helpers/ddd-model-generator.ts` " +
        "so it only produces valid `.ddd`, or the assertion below proves nothing",
    ).toEqual([]);
    expect(
      crashed.slice(0, 2),
      "the pipeline THREW on a valid model. A crash on valid input is always a bug: " +
        "either the model should have been rejected by a validator, or the emitter has a " +
        "hole. The seed reproduces it exactly — paste the printed source into a fixture.",
    ).toEqual([]);
  }, 600_000);

  it("emits the same bytes twice for every shape it generates", async () => {
    // The CLI-level twin of this (`test/cli/regeneration.test.ts`) proves
    // determinism end-to-end, across processes and timezones — but on ONE
    // fixture shape.  Nondeterminism that only a particular model reaches (an
    // unstable sort over a `Set` built from optional fields, a `Map` keyed by
    // something only a containment produces) is invisible to a single fixture
    // and is exactly what a shape generator is for.  Same models as the run
    // above, generated twice in-process and compared.
    //
    // A subset, because this is the expensive half: each seed costs a second
    // full codegen, and the shapes repeat long before the seeds do.
    const diverged: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 10) {
      const source = genModel(seed).replaceAll("__PLATFORM__", platformFor(seed));
      const a = await generateSystemFiles(source);
      const b = await generateSystemFiles(source);
      const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
      for (const p of paths) {
        if (a.get(p) !== b.get(p)) diverged.push(`seed ${seed}: ${p}`);
      }
    }
    expect(
      diverged.slice(0, 5),
      "two generations of the SAME model disagreed. Something ambient reached the output — " +
        "a clock, a uuid, an iteration order that is not a function of the model. The path " +
        "names the emitter.",
    ).toEqual([]);
  }, 600_000);

  it("is deterministic — the same seed yields the same model", () => {
    // Guards the harness itself. If the generator ever picked up ambient
    // randomness, a failure would stop reproducing from its seed and the whole
    // repro story above would be a lie.
    for (const seed of [1, 42, 250]) {
      expect(genModel(seed)).toBe(genModel(seed));
    }
    expect(genModel(1)).not.toBe(genModel(2));
  });

  it("actually generates the shapes it claims to cover", () => {
    // A generator that silently stopped emitting containments (or optionals, or
    // cross-aggregate references) would keep this suite green while testing a
    // fraction of what its comment advertises — the coverage-claim failure this
    // repo keeps finding. Sample the seed range and assert each shape appears.
    const corpus = Array.from({ length: SEEDS }, (_, i) => genModel(i + 1)).join("\n");
    for (const shape of [
      "with crudish",
      "contains lines:",
      "memo: string?",
      "derived display:",
      "invariant ",
      "operation touch()",
      "precondition ",
      "enum Status",
      "find by",
      " id\n", // a cross-aggregate `X id` field
    ]) {
      expect(corpus, `the generator never emitted \`${shape}\``).toContain(shape);
    }
  });
});
