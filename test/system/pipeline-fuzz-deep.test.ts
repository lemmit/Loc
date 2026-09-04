// The deep fuzz leg — shrinking, replay, and an OUTPUT oracle (M-T9.22, slice 2).
//
// Slice 1 (`pipeline-fuzz.test.ts`) asks one question of 250 shallow models in
// 12 seconds: does the pipeline throw?  It is in the fast suite, so it must
// stay that size, and that ceiling caps both axes that matter — how deep a
// model it may generate, and how much it may check about the OUTPUT.
//
// This leg lifts both, behind `LOOM_FUZZ_DEEP=1`:
//
//   ① MORE INPUT SPACE — `genModel(seed, { deep: true })` adds the regions
//     slice 1 cannot reach: value objects (a wire shape distinct from an
//     aggregate's on every backend), UI pages with real walker primitives and a
//     `menu {}` block, workflows and sagas (`create` + `emit` + `on … by`), and
//     the three find shapes (collection / optional-single / `paged`) over
//     scalar, enum and OPTIONAL fields.
//
//   ② ALL FIVE BACKENDS PER SEED — slice 1 spreads its seeds across backends
//     (`seed % 5`) because it cannot afford five codegens per model.  A spread
//     samples the per-backend emitters; it does not cover them.  A shape that
//     only the Java emitter mishandles is found by slice 1 only if it happens
//     to land on a seed ≡ 2 (mod 5).  Here every seed runs on all five.
//
//   ③ AN OUTPUT ORACLE — "did not throw" is a weak invariant.  An emitter that
//     hits a case it cannot handle often does NOT throw: it writes a `// TODO`
//     or a `# unsupported` marker into otherwise-compiling output and the gap
//     ships silently (the M-T9.8 failure mode).  So the emitted file map is
//     scanned for the unfinished-work vocabulary, and the enriched IR is put
//     through `assertLoomModelVerifies` — the contract the backends consume.
//
//   ④ SHRINKING — a failing 150-line random model is a bad bug report.  On any
//     failure the model is reduced (`test/_helpers/ddd-model-shrink.ts`) to the
//     few declarations that still reproduce it, and the shrunk `.ddd` is printed
//     corpus-ready.  That is what turns the mission's "every failure ships with
//     its seed" into a fixture someone can actually paste into
//     `test/fixtures/corpus/`.
//
// ── Env gates ───────────────────────────────────────────────────────────────
//   LOOM_FUZZ_DEEP=1        opt in (skipped otherwise, like every LOOM_* tier)
//   LOOM_FUZZ_DEEP_N=<n>    seed count (default below; 50 is a quick local pass)
//   LOOM_FUZZ_SEEDS=3,71    replay exactly these seeds — the hatch a reported
//                           failure is re-run through, and the only thing anyone
//                           needs from a failure report besides the source
//
// ── Why the tiers come from message-matching, not separate phase calls ──────
// `test/_helpers/generate.ts` (`generateSystemResult`) is the one legitimate
// path to the orchestrator (`direct-generate-systems-ratchet.test.ts` gates
// every other import of `generateSystems` in the test tree) and it folds
// "the fixture is invalid" and "the pipeline threw" into ONE exception.  For a
// hand-written fixture that is right — both mean fix the fixture.  Here they
// are opposite verdicts: an invalid model is a GENERATOR bug (and makes every
// assertion below vacuous), a crash on a valid one is a COMPILER bug.  Telling
// them apart is the whole point, so `check` recovers the tier from the
// phase-tagged text each failure mode throws (`(phase ④)`, `(phase ⑦)`, "IR
// verification failed for …") rather than re-running the phases separately —
// that keeps this leg off the gated import while still separating the tiers.

import { describe, expect, it } from "vitest";
import { genModel, genSpec } from "../_helpers/ddd-model-generator.js";
import { shrinkModel, specSize } from "../_helpers/ddd-model-shrink.js";
import { generateSystemResult } from "../_helpers/generate.js";

const ENABLED = process.env.LOOM_FUZZ_DEEP === "1";

/** Sized so a full run lands in the 10–20 minute band a nightly can carry:
 *  measured at 0.21 s per seed (5 backends, codegen + output scan), so 3500
 *  seeds ≈ 12 min.  `LOOM_FUZZ_DEEP_N=50` is the quick local pass (~11 s). */
const DEFAULT_N = 3500;

const REPLAY = (process.env.LOOM_FUZZ_SEEDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const SEEDS: number[] =
  REPLAY.length > 0
    ? REPLAY
    : Array.from({ length: Number(process.env.LOOM_FUZZ_DEEP_N ?? DEFAULT_N) }, (_, i) => i + 1);

const PLATFORMS = ["node", "python", "java", "dotnet", "elixir"] as const;

// ---------------------------------------------------------------------------
// The output oracle's sentinel rule.
//
// REPLICATED, not imported: `test/conformance/generated-output-sentinels.test.ts`
// keeps its regex and its allow list module-private (they are its own gate's
// knobs, and it has no exports at all).  The rule is copied verbatim rather
// than loosened — same vocabulary, same word boundaries, same 415 reason-phrase
// scrub — so the two gates agree about what an unfinished-work marker is.  If
// that test's set ever grows, this copy is the thing to update; the duplication
// is one regex, and exporting from a `.test.ts` file to make it shared would
// pull a whole corpus harness into this leg's import graph.
// ---------------------------------------------------------------------------
const SENTINEL = /\b(?:TODO|FIXME|XXX|HACK|unsupported|unimplemented)\b/i;
const LEGIT_PHRASES = [/Unsupported Media Type/g];

type Tier = "invalid" | "verify" | "crash" | "sentinel";

type Verdict =
  | { ok: true }
  | { ok: false; tier: Tier; key: string; detail: string; platform: string };

/** A failure identity that survives shrinking: the tier plus the message with
 *  its model-specific parts blanked.  Without it a shrink can wander from the
 *  crash it started on to an unrelated failure and report the wrong repro. */
const failureKey = (tier: Tier, message: string): string =>
  `${tier}: ${(message.split("\n")[0] ?? "")
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+/g, "N")
    .slice(0, 160)}`;

/** Phase-tagged text `test/_helpers/generate.ts` throws for a GENERATOR bug —
 *  a model the product itself rejects, at phase ①, ④ or ⑦. */
const INVALID_MODEL =
  /syntax error\(s\)|AST-validation error\(s\) \(phase ④\)|IR-validation error\(s\) \(phase ⑦\)/;

/** The prefix `assertLoomModelVerifies` throws with — a lowering/enrichment
 *  bug: the IR was built wrong, not declared wrong. */
const IR_CONTRACT_VIOLATION = /^IR verification failed for/;

/** The four oracle tiers, in order, for one (model, backend) pair. */
async function check(source: string, platform: string): Promise<Verdict> {
  const fail = (tier: Tier, message: string, detail = message): Verdict => ({
    ok: false,
    tier,
    key: failureKey(tier, message),
    detail,
    platform,
  });

  // ①③ `generateSystemResult` runs phases ①/④/⑤⑥(+the IR verify contract)/⑦
  // before calling the orchestrator, and folds all four into one exception —
  // recover which one fired from the phase-tagged text it throws.  Anything
  // else is the orchestrator itself throwing on a model the product accepted:
  // a PIPELINE bug, on THIS backend.
  let files: Map<string, string>;
  try {
    files = (await generateSystemResult(source)).files;
  } catch (e) {
    const message = (e as Error).message;
    if (INVALID_MODEL.test(message)) return fail("invalid", message);
    if (IR_CONTRACT_VIOLATION.test(message)) return fail("verify", message);
    return fail("crash", message);
  }

  // ④ …and what it wrote must not paper over a gap with a marker comment.
  for (const [rel, content] of files) {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const scrubbed = LEGIT_PHRASES.reduce((s, r) => s.replace(r, ""), lines[i] as string);
      const hit = SENTINEL.exec(scrubbed);
      if (hit === null) continue;
      return fail(
        "sentinel",
        `emitted '${hit[0]}' marker`,
        `${rel}:${i + 1}  ${(lines[i] as string).trim().slice(0, 140)}`,
      );
    }
  }
  return { ok: true };
}

/** Run one model across all five backends, returning the first failure. */
async function checkAllBackends(base: string): Promise<Verdict> {
  for (const platform of PLATFORMS) {
    const verdict = await check(base.replaceAll("__PLATFORM__", platform), platform);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

const TIER_ADVICE: Record<Tier, string> = {
  invalid:
    "the GENERATOR emitted an invalid model. Fix `test/_helpers/ddd-model-generator.ts` — " +
    "until it only produces valid `.ddd`, every other assertion in this leg is vacuous.",
  verify:
    "the enriched IR violated its own contract (`assertLoomModelVerifies`). The backends " +
    "consume this IR without re-resolving, so a violation here is a lowering/enrichment bug.",
  crash:
    "the pipeline THREW on a valid model. A crash on valid input is always a bug: either " +
    "the model should have been rejected by a validator, or the emitter has a hole.",
  sentinel:
    "an emitter papered over a gap with an unfinished-work marker instead of implementing " +
    "the case or failing loudly (M-T9.8). The output compiles, so no compile gate sees it.",
};

describe.skipIf(!ENABLED)(
  `pipeline fuzz — deep (LOOM_FUZZ_DEEP=1, ${SEEDS.length} seeds x ${PLATFORMS.length} backends)`,
  () => {
    it("generates, validates, emits and inspects the output of every seeded model", async () => {
      const reports: string[] = [];

      for (const seed of SEEDS) {
        const base = genModel(seed, { deep: true });
        const verdict = await checkAllBackends(base);
        if (verdict.ok) continue;

        // Shrink against THIS failure — same tier, same normalised message —
        // on the backend that produced it.  A predicate that accepted any
        // failure would happily reduce a Java codegen crash into an unrelated
        // validation error and print a repro for a bug nobody hit.
        const shrunk = await shrinkModel(genSpec(seed), async (candidate) => {
          const v = await check(
            candidate.replaceAll("__PLATFORM__", verdict.platform),
            verdict.platform,
          );
          return !v.ok && v.key === verdict.key;
        });
        reports.push(
          [
            `seed ${seed} [${verdict.platform}] — ${verdict.tier}`,
            `  ${TIER_ADVICE[verdict.tier]}`,
            `  ${verdict.detail.split("\n").slice(0, 4).join("\n  ")}`,
            `  shrunk: ${specSize(genSpec(seed))} -> ${specSize(shrunk.spec)}` +
              ` (${shrunk.steps} steps, ${shrunk.tried} candidates${shrunk.exhausted ? ", budget exhausted" : ""})`,
            `  replay: LOOM_FUZZ_DEEP=1 LOOM_FUZZ_SEEDS=${seed} npm run test:fuzz-deep`,
            "  ---8<--- corpus-ready .ddd (shrunk) ---",
            shrunk.source
              .replaceAll("__PLATFORM__", verdict.platform)
              .split("\n")
              .map((l) => `  ${l}`)
              .join("\n"),
            "  --->8---",
          ].join("\n"),
        );
      }

      expect(
        reports.slice(0, 3).join("\n\n"),
        "the deep fuzz leg found a failing model. Each report carries its seed (replay it " +
          "with LOOM_FUZZ_SEEDS), the tier that says whose bug it is, and a SHRUNK .ddd " +
          "ready to paste into test/fixtures/corpus/ as a regression fixture.",
      ).toBe("");
    }, 3_600_000);
  },
);

// ---------------------------------------------------------------------------
// Harness self-checks.  Pure and instant, so they run in the FAST suite too —
// the deep leg's own correctness must not itself be gated behind the env var it
// guards, or a broken generator sits undetected until someone runs the nightly.
// ---------------------------------------------------------------------------
describe("deep fuzz harness", () => {
  it("is deterministic — the same seed yields the same deep model", () => {
    for (const seed of [1, 42, 199]) {
      expect(genModel(seed, { deep: true })).toBe(genModel(seed, { deep: true }));
    }
    expect(genModel(1, { deep: true })).not.toBe(genModel(2, { deep: true }));
  });

  it("leaves the slice-1 shape alone", () => {
    // `genModel(seed)` is `pipeline-fuzz.test.ts`'s whole corpus. If the deep
    // arm ever leaks into the default call the fast leg silently starts testing
    // something else — and its 250 seeds would stop matching any recorded repro.
    for (const seed of [1, 7, 250]) {
      const shallow = genModel(seed);
      expect(shallow).not.toContain("valueobject ");
      expect(shallow).not.toContain("workflow ");
      expect(shallow).not.toContain("  ui ");
    }
  });

  it("actually generates the shapes the deep arm claims to cover", () => {
    // The coverage-claim failure this repo keeps rediscovering: a generator
    // that quietly stopped emitting a shape keeps every suite green while
    // testing a fraction of what its comment advertises.
    const corpus = Array.from({ length: 120 }, (_, i) => genModel(i + 1, { deep: true })).join(
      "\n",
    );
    for (const shape of [
      "valueobject ",
      "invariant value >= 0",
      "workflow place",
      "emit ",
      "on(e: ",
      " paged",
      "? where this.", // an optional-single find (`find byX(v: T): Agg? where …`)
      "memo: string?",
      "  ui U {",
      "menu {",
      'section "Main"',
      "QueryView {",
      "Column {",
      "CreateForm {",
      "Stat {",
      "Card {",
      "platform: react",
      " id\n", // a cross-aggregate `X id` field
    ]) {
      expect(corpus, `the deep arm never emitted \`${shape}\``).toContain(shape);
    }
  });

  it("shrinks a model down to the declaration that carries the property", async () => {
    // Mutation-shaped self-test for the shrinker: a synthetic predicate that
    // only cares about ONE declaration must reduce the model to (about) that
    // declaration.  Without this the shrinker could silently no-op — and a
    // shrinker that always returns its input looks exactly like a model that
    // was already minimal.
    const seed = [...Array(200).keys()]
      .map((i) => i + 1)
      .find((s) => {
        const spec = genSpec(s);
        return spec.vos.length > 0 && spec.aggs.length > 1 && spec.ui !== null;
      });
    expect(seed, "no seed in 1..200 produced a vo + multi-aggregate + ui model").toBeDefined();

    const before = genSpec(seed as number);
    const result = await shrinkModel(before, async (src) => src.includes("valueobject "));
    expect(result.source).toContain("valueobject ");
    // Everything the predicate does not need is gone.
    expect(result.spec.ui).toBeNull();
    expect(result.spec.workflows).toEqual([]);
    expect(result.spec.aggs.length).toBe(1);
    expect(result.spec.vos.length).toBe(1);
    expect(result.steps).toBeGreaterThan(0);
    // …and it is a strictly smaller model than it started from.
    expect(result.source.length).toBeLessThan(genModel(seed as number, { deep: true }).length);
  });

  it("shrinks deterministically", async () => {
    const spec = genSpec(11);
    const p = async (src: string): Promise<boolean> => src.includes("aggregate ");
    const a = await shrinkModel(spec, p);
    const b = await shrinkModel(spec, p);
    expect(a.source).toBe(b.source);
    expect(a.steps).toBe(b.steps);
  });
});
