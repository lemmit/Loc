import { generateDotnet } from "../../src/generator/dotnet/index.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateTypeScript } from "../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../src/platform/hono/v4/pins.js";
import { generateSystems } from "../../src/system/index.js";
import { extractErrors, parseString } from "./parse.js";

export { HONO_V4_PINS };

/** Generate the single-context Hono/TS project file map from an AST Model. */
export const generateHono = (model: Model): Map<string, string> =>
  generateTypeScript(model, HONO_V4_PINS);

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
 * NOT asserted here: phase ⑦ (`validateLoomModel`).  `generateSystems` does not
 * run it either, so asserting it would gate this helper on a phase the code
 * under test never sees; that is M-T9.34 slice 2, which has its own drain
 * (776 calls at the census, dominated by `loom.persistence-mode-unsupported`).
 */
export async function generateSystemFiles(source: string): Promise<Map<string, string>> {
  const { model, doc } = await parseString(source);
  const syntaxErrors = doc.parseResult.parserErrors;
  if (syntaxErrors.length) {
    throw new Error(
      `.ddd fixture has ${syntaxErrors.length} syntax error(s) — the emitted AST is ` +
        `error-recovered, so anything this test asserts is meaningless:\n` +
        syntaxErrors.map((e) => `  ${e.message}`).join("\n"),
    );
  }
  const validationErrors = extractErrors(doc.diagnostics ?? []);
  if (validationErrors.length) {
    throw new Error(
      `.ddd fixture has ${validationErrors.length} validation error(s) — \`ddd generate\` ` +
        `would exit non-zero on it, so the emitted output this test asserts against is ` +
        `output no user can obtain.  Fix the fixture, or call ` +
        `generateSystemFilesUnchecked(source, "<why this model must stay invalid>") if ` +
        `emitting from a rejected model IS the subject:\n` +
        validationErrors.map((e) => `  ${e}`).join("\n"),
    );
  }
  return generateSystems(model).files;
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

/** Re-exported for symmetry — generates the single .NET project file map. */
/** Re-exported — full multi-deployable system emission orchestrator. */
export { generateDotnet, generateSystems };
