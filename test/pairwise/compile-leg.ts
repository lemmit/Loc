// ---------------------------------------------------------------------------
// The pairwise COMPILE oracle, shared across backends.
//
// Slice 1 shipped one compile leg (node/strict `tsc`) and said so explicitly:
// "node-only by design; the dotnet / java / python / elixir compile legs are a
// named follow-up slice ... this slice's job is to prove the harness earns
// them."  It has: #2527 / #2528 / #2529 all came out of it.
//
// WHY THE OTHER FOUR MATTER MORE THAN A FIFTH COPY OF THE SAME CHECK.  The
// generation sweep next door covers all five backends, but it can only see a
// crossing that THROWS.  The bug class this whole corpus exists for is the one
// that generates perfectly and then fails to compile — and every recorded
// instance of it failed somewhere OTHER than node:
//
//   #2412  `mask unless` × `audited`      → .NET CS0128 + Python F821
//   #2387  `audited` × dapper × document  → uncompilable .NET
//   #2391  `audited` × dapper × eventLog  → uncompilable .NET
//   #2181  channels × rabbit              → .NET /warnaserror
//
// A node-only compile tier is therefore blind to its own motivating class, and
// blind in the exact direction the repo keeps getting burned: node is the
// backend a fix lands on first, so it is the backend most likely to be already
// green.  #2664 measured the same asymmetry from the contract side — three
// schemathesis findings the register recorded as CLOSED were still open on the
// other backends, because all three fixes had landed on Hono alone.
//
// WHAT DIFFERS PER BACKEND is only the toolchain: how dependencies are
// materialized and what command decides "this compiles".  The case iteration,
// the verdict handling (rejected → nothing to compile; crashed → owned by the
// generation register) and BOTH directions of the waiver ratchet are identical,
// so they live here once and each leg supplies a recipe.  Same core/leg split
// #2664 used for the schemathesis backends.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { caseId, type PairwiseCase, type Persistence } from "./axes.js";
import { pairwiseCover } from "./cases.js";
import { runPipeline } from "./harness.js";
import { GENERATION_WAIVERS, waiverFor } from "./waivers.js";
import { COMPILE_WAIVERS } from "./waivers-compile.js";

/** What a backend must supply to get a compile leg. */
export interface CompileRecipe {
  /** `platform:` clause value — also the key both waiver registers match on. */
  readonly platform: string;
  /** Human name in the describe block. */
  readonly label: string;
  /** `LOOM_*` gate; the leg is skipped unless this is `"1"`. */
  readonly enabled: boolean;
  /**
   * Narrow the cover's persistence axis. Omit for "every adapter this platform
   * reaches" (`persistenceFor`). A leg passes a list only when an adapter is
   * genuinely un-compilable rather than merely un-interesting — an adapter
   * dropped for convenience is a hole with no register row.
   */
  readonly persistence?: readonly Persistence[];
  /**
   * Relative path from the emitted tree root to the project the compiler runs
   * in. The pairwise composer emits one deployable named `d`, but each backend
   * nests its project differently.
   */
  readonly projectDir: (root: string) => string;
  /**
   * Compile `proj`. Return `undefined` when it compiles, or the captured
   * diagnostics when it does not. MUST NOT throw for an ordinary compile
   * failure — a thrown error is a harness fault and fails the case loudly,
   * which is the correct outcome for "the toolchain itself is broken" but the
   * wrong one for "the emitted code is bad".
   */
  readonly compile: (proj: string, kase: PairwiseCase) => string | undefined;
  /** Per-case timeout; toolchains differ by an order of magnitude. */
  readonly timeoutMs: number;
}

// ---------------------------------------------------------------------------
// INFRA FAILURE vs FINDING — the distinction the whole leg exists to make.
//
// Every recipe shells out to a containerised toolchain and returns whatever the
// process printed.  That conflates two completely different outcomes: "the
// emitted code does not compile" (a FINDING) and "the compiler never ran" (a
// HARNESS FAULT).  Reported as the first, the second is worse than useless — it
// manufactures N identical fake findings and buries any real one among them.
//
// Both failure modes were observed within an hour of this leg existing:
//
//   * the elixir leg's first full run — 17 of 25 cases "failed" with identical
//     `mix local.hex` hex.pm timeouts (fixed by retrying the install, but the
//     leg still could not TELL);
//   * a reaped `dockerd` — all 21 remaining cases "failed to compile" with
//     `failed to connect to the docker API at unix:///var/run/docker.sock`.
//
// Neither had read a byte of emitted code.  So the core classifies first: an
// output matching a known infra signature THROWS, failing the case loudly as a
// harness fault, and never reaches the waiver ratchet — a run that cannot reach
// its subject must not be allowed to look like a verdict about it (§59/§63).
// ---------------------------------------------------------------------------

const INFRA_SIGNATURES: readonly RegExp[] = [
  // Docker itself is unreachable / the daemon was reaped mid-run.
  /failed to connect to the docker API/i,
  /Cannot connect to the Docker daemon/i,
  /docker: command not found/i,
  // The toolchain image could not be pulled.
  /(manifest|pull access) (unknown|denied)/i,
  /error pulling image|failed to (pull|resolve) (reference|image)/i,
  // The registries every leg fetches dependencies from.
  /Could not install Hex because Mix could not download/i,
  /request timed out after \d+ms/i,
  /Could not resolve host|Temporary failure in name resolution/i,
  /(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN)\b/,
  /NU1301|unable to load the service index/i, // NuGet
  /Could not GET .*repo\.maven|Read timed out/i, // Gradle
  // No space left mid-build — the sandbox's fixed writable allowance.
  /no space left on device/i,
  // Mix printing a bare `:timeout` atom, usually many times, while resolving
  // hex deps.  Added because it SLIPPED THROUGH: the elixir cover's clean run
  // still reported one "compile failure" whose entire body was `:timeout`
  // repeated around `Resolving Hex dependencies...`, with no compiler
  // diagnostic anywhere.  A signature list only catches what it has seen, so an
  // unmatched infra failure lands as a FAKE FINDING — the exact direction this
  // classifier is least able to notice about itself.
  /^\s*:timeout\s*$/m,
  /Resolving Hex dependencies\.\.\.[\s\S]*:timeout/,
];

/** The infra signature `out` matches, if any — exported for its own gate
 *  (`compile-leg.test.ts`), which pins BOTH directions: real infra text is
 *  caught, and real compiler diagnostics are not swallowed. */
export function infraFailure(out: string): string | undefined {
  return INFRA_SIGNATURES.find((re) => re.test(out))?.source;
}

/**
 * Register one backend's compile leg.
 *
 * The ratchet runs BOTH ways, and the second direction is the one a leg that
 * only ever runs by hand silently forfeits: a waived case that starts compiling
 * fails until its entry is deleted. (That arm is why the first CI run of this
 * corpus found four waivers whose bugs had been fixed weeks earlier.)
 */
export function describeCompileLeg(recipe: CompileRecipe): void {
  const cases = pairwiseCover(recipe.platform, recipe.persistence);
  const only = process.env.LOOM_PAIRWISE_COMPILE_CASE;
  const selected = cases.filter((c) => !only || caseId(c) === only);
  const scratch: string[] = [];

  describe.skipIf(!recipe.enabled)(
    `pairwise corpus — the emitted ${recipe.label} project compiles`,
    () => {
      afterAll(() => {
        for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
      });

      it("the cover is non-empty (a leg that selects nothing passes vacuously)", () => {
        expect(
          selected.length,
          `${recipe.platform}: pairwiseCover selected no cases`,
        ).toBeGreaterThan(0);
      });

      it.each(selected.map((c) => [caseId(c), c] as const))(
        "%s",
        async (_id, kase: PairwiseCase) => {
          const out = await runPipeline(kase, recipe.platform);

          if (out.verdict === "rejected") {
            // A named `loom.*` refusal is a legitimate answer and there is no
            // project to compile. Say so rather than passing silently — a leg
            // that quietly skips is how a compile tier becomes a no-op.
            console.log(
              `${caseId(kase)}: rejected by ${out.codes.join(", ")} — nothing to compile`,
            );
            return;
          }
          if (out.verdict === "crashed") {
            // Owned by the generation oracle's register; asserting it again here
            // would double-count one finding as two.
            expect(
              waiverFor(GENERATION_WAIVERS, kase, recipe.platform),
              `${caseId(kase)} crashed in codegen with no generation waiver`,
            ).toBeDefined();
            return;
          }

          const outDir = fs.mkdtempSync(
            path.join(os.tmpdir(), `loom-pw-${recipe.platform}-${caseId(kase)}-`),
          );
          scratch.push(outDir);
          try {
            for (const [rel, content] of out.files!) {
              const abs = path.join(outDir, rel);
              fs.mkdirSync(path.dirname(abs), { recursive: true });
              fs.writeFileSync(abs, content);
            }
            const proj = recipe.projectDir(outDir);
            expect(
              fs.existsSync(proj),
              `${caseId(kase)}: ${recipe.label} project emitted at ${path.relative(outDir, proj)}`,
            ).toBe(true);

            const failure = recipe.compile(proj, kase);

            // Classify BEFORE the ratchet: an infra failure is not a verdict
            // about the emitted code, in either direction.  Treating it as one
            // would both invent a finding and — on a waived case — read as
            // "still broken", quietly holding a waiver whose bug may be fixed.
            const infra = failure && infraFailure(failure);
            if (infra) {
              throw new Error(
                `${caseId(kase)}: HARNESS FAULT, not a finding — the ${recipe.label} toolchain ` +
                  `never compiled anything (matched /${infra}/).  Fix the environment and re-run; ` +
                  `do NOT add a waiver for this.\n${failure.slice(0, 1500)}`,
              );
            }

            const waiver = waiverFor(COMPILE_WAIVERS, kase, recipe.platform);

            if (waiver) {
              expect(
                failure,
                `${caseId(kase)} now compiles on ${recipe.platform} — drop "${recipe.platform}" ` +
                  `from its entry in test/pairwise/waivers-compile.ts (delete the entry when no ` +
                  `platform is left) and close its row in the findings register`,
              ).toBeDefined();
            } else {
              expect(
                failure,
                `${caseId(kase)}: emitted ${recipe.label} project failed to compile`,
              ).toBeUndefined();
            }
          } finally {
            fs.rmSync(outDir, { recursive: true, force: true });
          }
        },
        recipe.timeoutMs,
      );
    },
  );
}
