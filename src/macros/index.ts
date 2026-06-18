// macros barrel + boot helper.
//
// Single entry point for the language module: loads the stdlib macros
// into the shared registry and attaches the expander listener to
// Langium's shared services.  Keeps expander.ts agnostic of which
// macro libraries exist — any caller can registerMacro(...) without
// going through stdlib.

import type { LangiumSharedServices } from "langium/lsp";
import { registerMacroExpander } from "./expander.js";
import { loadStdlibMacros } from "./stdlib/index.js";

/** Idempotently load the stdlib macros and register the expander
 * listener on the shared `DocumentBuilder`.  Called once during
 * language module init (see src/language/ddd-module.ts). */
export function bootMacros(shared: LangiumSharedServices): void {
  loadStdlibMacros();
  registerMacroExpander(shared);
}

// Re-export the public surface for callers that still want direct
// access (validators, LSP code-actions, tests).
export {
  collectUnresolvedMacroRefs,
  drainMacroDiagnostics,
  registerMacroExpander,
  resolveMacroArgs,
} from "./expander.js";
export { _resetRegistryForTests, allMacros, lookupMacro, registerMacro } from "./registry.js";
