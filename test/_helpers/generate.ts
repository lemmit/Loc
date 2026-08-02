import { generateDotnet } from "../../src/generator/dotnet/index.js";
import type { Model } from "../../src/language/generated/ast.js";
import { generateTypeScript } from "../../src/platform/hono/v4/emit.js";
import { BACKEND_PINS as HONO_V4_PINS } from "../../src/platform/hono/v4/pins.js";
import { generateSystems } from "../../src/system/index.js";
import { parseString } from "./parse.js";

export { HONO_V4_PINS };

/** Generate the single-context Hono/TS project file map from an AST Model. */
export const generateHono = (model: Model): Map<string, string> =>
  generateTypeScript(model, HONO_V4_PINS);

/**
 * Parse a `.ddd` string and run the full system orchestrator, returning the
 * emitted file map. Runs validation but does not assert it — the canonical
 * setup for walker / generator-output tests, many of which deliberately emit
 * from a model carrying VALIDATION diagnostics (gated features, negative
 * cases).
 *
 * SYNTAX errors are a different animal and are asserted: Langium's error
 * recovery hands back a partial AST, so a fixture with a typo'd header still
 * "generates" and its test still passes — against a model that silently
 * dropped whatever the parser couldn't consume. That masked ten
 * `aggregate Order ids guid { … }` fixtures across five backends for the
 * whole life of the removed `ids` clause (#2328).
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
  return generateSystems(model).files;
}

/** Re-exported for symmetry — generates the single .NET project file map. */
/** Re-exported — full multi-deployable system emission orchestrator. */
export { generateDotnet, generateSystems };
