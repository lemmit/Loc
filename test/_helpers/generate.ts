import { generateDotnet as generateDotnetProject } from "../../src/generator/dotnet/index.js";
import { enrichLoomModel } from "../../src/ir/enrich/enrichments.js";
import { lowerModel, mergeLoomModels } from "../../src/ir/lower/lower.js";
import { validateLoomModel } from "../../src/ir/validate/validate.js";
import { assertLoomModelVerifies } from "../../src/ir/verify/verify-ir.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateTypeScript } from "../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../src/platform/hono/v4/pins.js";
import {
  type GenerateSystemOptions,
  generateSystems,
  type SystemEmission,
} from "../../src/system/index.js";
import { extractErrors, parseString } from "./parse.js";

export { HONO_V4_PINS };

/**
 * Phases ⑤/⑥/⑦ over an already-parsed AST Model — lower, merge, enrich, then
 * the IR verifier and `validateLoomModel`.  Synchronous, so it can ride the
 * synchronous legacy `generate` helpers as well as the async ones.
 *
 * This is the shared body of the phase-⑤-and-later half of `assertGeneratable`;
 * both call it so the two paths cannot drift.  The whole point of extracting it
 * was `generateHono` below: at the 2026-09 census that wrapper was one line with
 * no checks at all, and its **66 call sites across 37 files** were the last
 * corner of the tree that could assert on emitted output from an IR nothing had
 * ever looked at (M-T9.44).
 */
export function assertModelVerifies(model: Model, context = ".ddd fixture"): void {
  // Phases ⑤/⑥ — the IR the backends will consume must hold its own contract
  // before phase ⑦ is asked whether the MODEL is valid.  Ordered first because
  // the two answer different questions and a violation here invalidates the
  // one below: `validateLoomModel` reads `refKind`, `receiverType` and
  // `callKind` off the IR, so a check running on a malformed IR reports on
  // something that was never built correctly.
  const enriched = enrichLoomModel(mergeLoomModels([lowerModel(model)]));
  assertLoomModelVerifies(enriched, context);
  // Phase ⑦ — the same call the CLI and the api toolkit make.
  const irErrors = validateLoomModel(enriched).filter((d) => d.severity === "error");
  if (irErrors.length) {
    throw new Error(
      `${context} has ${irErrors.length} IR-validation error(s) (phase ⑦) — ` +
        `\`ddd generate\` would exit non-zero on it, so the emitted output this test ` +
        `asserts against is output no user can obtain.  Fix the fixture, or call ` +
        `generateSystemFilesUnchecked(source, "<why this model must stay invalid>") if ` +
        `emitting from a rejected model IS the subject:\n` +
        irErrors.map((d) => `  ${d.code ?? "?"} ${d.message}`).join("\n"),
    );
  }
}

/**
 * Generate the single-context Hono/TS project file map from an AST Model.
 *
 * Runs `assertModelVerifies` first, so this legacy single-context path asserts
 * everything `generateSystemFiles` asserts about the IR — phases ⑤/⑥ via the
 * verifier and phase ⑦ via `validateLoomModel`.  Phases ① and ④ are the
 * CALLER's, because this helper takes a Model rather than a source string: a
 * caller that reaches it through `parseValid` has both; one that reaches it
 * through a bare `parseString` has neither, which is what
 * `test/system/legacy-generate-path-ratchet.test.ts` pins.
 */
export const generateHono = (model: Model): Map<string, string> => {
  assertModelVerifies(model);
  return generateTypeScript(model, HONO_V4_PINS);
};

/**
 * Generate the single-context .NET project file map from an AST Model.
 *
 * The .NET twin of `generateHono` above, and it was the same hole: until
 * M-T9.45 this name was RE-EXPORTED straight from
 * `src/generator/dotnet/index.js`, so the helper wrapped it with nothing.  Its
 * call sites asserted on emitted C# from an IR nothing had ever inspected —
 * and most of them did not even reach the helper, importing the generator
 * directly from `src/` and so sitting outside every gate this module has.
 *
 * Now a real wrapper: `assertModelVerifies` first, exactly as `generateHono`
 * does, from the same shared body so the two legacy paths cannot drift.
 * Phases ① and ④ are the CALLER's for the same reason as above — this takes a
 * `Model`, not a source string — which is what the `parseString` column of
 * `test/system/legacy-generate-path-ratchet.test.ts` pins.
 */
export const generateDotnet = (
  model: Model,
  options: { emitTrace?: boolean } = {},
): Map<string, string> => {
  assertModelVerifies(model);
  return generateDotnetProject(model, options);
};

/**
 * The phases a `.ddd` fixture must survive before any test may assert on what
 * it emits — ① syntax, ④ AST validation, ⑦ IR validation.  Throws with the
 * offending diagnostics; the message names the escape hatch.
 *
 * Phase ⑦ is asserted here even though `generateSystems` does not run it.  That
 * looks like gating the helper on a phase the code under test never sees, and
 * it is deliberate: the CLI DOES run it (`src/cli/main.ts`, `src/api/index.ts`),
 * so a fixture that fails it is a fixture no user can generate from, whatever
 * the orchestrator would have done with it.  A test asserting on that output is
 * asserting on output that does not exist in the product.
 */
async function assertGeneratable(source: string): Promise<Model> {
  const { model, doc } = await parseString(source);
  const syntaxErrors = doc.parseResult.parserErrors;
  if (syntaxErrors.length) {
    throw new Error(
      `.ddd fixture has ${syntaxErrors.length} syntax error(s) — the emitted AST is ` +
        `error-recovered, so anything this test asserts is meaningless:\n` +
        syntaxErrors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  const astErrors = extractErrors(doc.diagnostics ?? []);
  if (astErrors.length) {
    throw new Error(
      `.ddd fixture has ${astErrors.length} AST-validation error(s) (phase ④) — ` +
        `\`ddd generate\` would exit non-zero on it, so the emitted output this test ` +
        `asserts against is output no user can obtain.  Fix the fixture, or call ` +
        `generateSystemFilesUnchecked(source, "<why this model must stay invalid>") if ` +
        `emitting from a rejected model IS the subject:\n` +
        astErrors.map((e) => `  ${e}`).join("\n"),
    );
  }
  // Phases ⑤/⑥/⑦ — free, or nearly: the enriched model is computed here anyway
  // for phase ⑦, and the verifier walks it once more.  That is the whole reason
  // the verifier can ride the shared helper at all rather than living in one
  // gate — every fixture in the tree checks the contract because the helper
  // they all go through already had the model in hand.
  assertModelVerifies(model);
  return model;
}

/**
 * Parse a `.ddd` string and run the full system orchestrator, returning the
 * emitted file map.
 *
 * The fixture must be one the toolchain ACCEPTS — no syntax errors (phase ①)
 * and no AST-validation errors (phase ④).  Both are asserted, for the same
 * reason:
 *
 *   SYNTAX — Langium's error recovery hands back a partial AST, so a fixture
 *   with a typo'd header still "generates" and its test still passes, against a
 *   model that silently dropped whatever the parser couldn't consume.  That
 *   masked ten `aggregate Order ids guid { … }` fixtures across five backends
 *   for the whole life of the removed `ids` clause (#2328).
 *
 *   VALIDATION — this helper used to run phase ④ and throw the result away, and
 *   the 2026-08-13 census found what that bought: fixtures whose ui declared
 *   `api Sales: SalesApi` and whose deployable never bound it, `+=` against an
 *   `int`, `from`-clauses naming a subdomain that does not exist.  Each test
 *   still asserted on emitted output — output no user could ever obtain, since
 *   `ddd generate` exits non-zero on those models.  It is the general case of
 *   #2489 (a gate "green on approximately nothing" because its Phoenix leg
 *   generated from a validator-REJECTED system) and of #2512's harness bug (a
 *   harness that runs fewer phases than the product invents bugs and hides
 *   real ones).
 *
 * A test that genuinely needs to emit from a rejected model — a degradation
 * path, a gated feature — calls `generateSystemFilesUnchecked` and says why.
 *
 *   IR VALIDATION (phase ⑦) — asserted since M-T9.34 slice 2.  `generateSystems`
 *   does not run `validateLoomModel` itself, but the CLI and the api toolkit do,
 *   so a fixture that fails it is one no user can generate from.  The drain that
 *   made this assertable cleared 974 error-carrying generations across 149 files.
 *
 * See `assertGeneratable` above for all three.
 */
export async function generateSystemFiles(
  source: string,
  options: GenerateSystemOptions = {},
): Promise<Map<string, string>> {
  return generateSystems(await assertGeneratable(source), options).files;
}

/**
 * `generateSystemFiles` for the rare fixture that must stay invalid — a
 * degradation path, a validator-gated feature whose emitter is still expected
 * to do something sane.
 *
 * `why` is required and goes nowhere: it exists so the exception is a sentence
 * in the diff rather than a silent second import.  Syntax errors are still
 * fatal — an error-recovered AST is meaningless whatever the test is about.
 */
export async function generateSystemFilesUnchecked(
  source: string,
  why: string,
): Promise<Map<string, string>> {
  if (why.trim().length < 15) {
    throw new Error(
      `generateSystemFilesUnchecked needs a real reason, not "${why}" — it is the ` +
        `only record of why this fixture is allowed to be one the product refuses.`,
    );
  }
  const { model, doc } = await parseString(source);
  const syntaxErrors = doc.parseResult.parserErrors;
  if (syntaxErrors.length) {
    throw new Error(
      `.ddd fixture has ${syntaxErrors.length} syntax error(s) — the emitted AST is ` +
        `error-recovered, so anything this test asserts is meaningless:\n` +
        syntaxErrors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  return generateSystems(model).files;
}

/**
 * `generateSystemFiles`, but returning the WHOLE `SystemEmission` — diagnostics,
 * migrations, the snapshot store — not just `.files`.
 *
 * It exists to remove the last honest reason to call `generateSystems` directly.
 * At the 2026-08-17 census **223 test files** do exactly that (465 call sites),
 * which puts them outside every phase gate this module gained: no syntax check,
 * no phase ④, and nothing to flip for phase ⑦ later.  260 of those call sites
 * only wanted `.files`; the rest wanted the full result or an options argument
 * (`{ sourcemap: true }`), which the file-only helper could not give them.  Both
 * are now covered here, so migrating a direct caller is a one-line change rather
 * than a capability loss.
 *
 * The migration itself is deliberately NOT done here, and the reason is
 * measured rather than assumed.  Instrumenting `generateSystems` ITSELF over a
 * full run (9,276 calls) puts the real damage at **266 error-carrying
 * generations across 54 files** — far less than the 223-file surface implies,
 * because most direct callers already parse through `parseValid` (which does
 * assert phase ④) or simply have valid fixtures.  201 of the 266 are the same
 * `loom.persistence-mode-unsupported` class drained through this helper.
 *
 * They are NOT a codemod job, which was tried and reverted: these fixtures pin
 * seed SQL, migration chains and saga dispatch, so binding a `resource` moves
 * real emitted output (tables become schema-qualified) and 30 tests fail for
 * reasons that each need reading.  Per-file, with the emission diff reviewed —
 * its own slice.  A ratchet forbidding the direct import is only fair once that
 * is done; this helper is the prerequisite, not the enforcement.
 */
export async function generateSystemResult(
  source: string,
  options: GenerateSystemOptions = {},
): Promise<SystemEmission> {
  return generateSystems(await assertGeneratable(source), options);
}

/** Re-exported — full multi-deployable system emission orchestrator. */
export { generateSystems };
