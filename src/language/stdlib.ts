// The Loom standard prelude — parse-once ambient index (stdlib Phase C, C1).
//
// The prelude source (`stdlib-source.ts`) is parsed ONCE, synchronously, on an
// isolated `EmptyFileSystem` service instance (browser-safe, no fs), and its
// top-level `function`s are exposed as a name → decl map.  Each resolution
// layer consults this index with USER-WINS ordering:
//   - unknown-name gate (`validators/names.ts`) — std names are admitted;
//   - type system (`type-system.ts` `lookupTopLevelFunction`) — after local
//     members AND user top-level functions, so a user decl shadows;
//   - lowering (`ir/lower/lower.ts`) — merged into `topLevelFnIndex` only for
//     names the user did not declare, so the user's inlines instead.
//
// Because std functions are expression-form, a call inlines their body at the
// use site (`inlineTopLevelFn`); an uncalled std function emits nothing.

import { EmptyFileSystem, URI } from "langium";
import { createDddServices } from "./ddd-module.js";
import { type FunctionDecl, isFunctionDecl, type Model } from "./generated/ast.js";
import { STD_SOURCES } from "./stdlib-source.js";

let cached: ReadonlyMap<string, FunctionDecl> | undefined;

/** The ambient prelude's top-level functions, name → decl.  First declaration
 *  wins on a cross-module name collision within the prelude (there are none by
 *  construction).  Parsed lazily and cached for the process lifetime — the
 *  prelude source is constant, so one parse suffices. */
export function stdFunctions(): ReadonlyMap<string, FunctionDecl> {
  if (cached) return cached;
  const { shared } = createDddServices(EmptyFileSystem);
  const factory = shared.workspace.LangiumDocumentFactory;
  const out = new Map<string, FunctionDecl>();
  for (const [name, source] of Object.entries(STD_SOURCES)) {
    const doc = factory.fromString<Model>(source, URI.parse(`memory:///loom-std/${name}.ddd`));
    const errors = doc.parseResult.parserErrors;
    if (errors.length > 0) {
      // A prelude that doesn't parse is a toolchain bug, not user error.
      throw new Error(`Loom stdlib module '${name}' failed to parse: ${errors[0]?.message}`);
    }
    for (const m of doc.parseResult.value.members) {
      if (isFunctionDecl(m) && !out.has(m.name)) out.set(m.name, m);
    }
  }
  cached = out;
  return out;
}

/** The prelude function `name`, or undefined. */
export function stdFunction(name: string): FunctionDecl | undefined {
  return stdFunctions().get(name);
}

/** True iff `name` is a prelude function (used by the unknown-name gate). */
export function isStdFunctionName(name: string): boolean {
  return stdFunctions().has(name);
}
