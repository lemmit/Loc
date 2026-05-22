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
 * setup for walker / generator-output tests.
 */
export async function generateSystemFiles(source: string): Promise<Map<string, string>> {
  return generateSystems((await parseString(source)).model).files;
}

/** Re-exported for symmetry — generates the single .NET project file map. */
/** Re-exported — full multi-deployable system emission orchestrator. */
export { generateDotnet, generateSystems };
