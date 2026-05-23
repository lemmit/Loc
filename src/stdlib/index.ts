// Stdlib macro bundle.  Imported once at toolchain start to
// register every shipped macro into the global registry.

import { registerMacro } from "../language/macro-registry.js";
import auditable from "./auditable.macro.js";
import crudish from "./crudish.macro.js";
import softDeletable from "./softDeletable.macro.js";

let _loaded = false;

/** Idempotently register all stdlib macros.  Safe to call from
 * multiple entry points (CLI, LSP, web playground, test harnesses)
 * — only the first call has effect. */
export function loadStdlibMacros(): void {
  if (_loaded) return;
  _loaded = true;
  registerMacro(auditable);
  registerMacro(softDeletable);
  registerMacro(crudish);
}

/** Test/harness hook: allow tests that reset the registry to
 * re-register the stdlib without re-importing. */
export function _resetStdlibLoadFlag(): void {
  _loaded = false;
}
