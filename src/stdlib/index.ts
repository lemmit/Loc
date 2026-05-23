// Stdlib macro bundle.  Imported once at toolchain start to
// register every shipped macro into the global registry.

import { registerMacro } from "../language/macro-registry.js";
import audit from "./audit.macro.js";
import auditable from "./auditable.macro.js";
import auditedByDefault from "./auditedByDefault.macro.js";
import crudish from "./crudish.macro.js";
import scaffold from "./scaffold.macro.js";
import softDeletable from "./softDeletable.macro.js";
import softDelete from "./softDelete.macro.js";
import softDeleteByDefault from "./softDeleteByDefault.macro.js";

let _loaded = false;

/** Idempotently register all stdlib macros.  Safe to call from
 * multiple entry points (CLI, LSP, web playground, test harnesses)
 * — only the first call has effect.
 *
 * Stdlib organisation: each capability ships as a trio of macros at
 * three levels.  The aggregate-level macro adds storage state; the
 * context-level macro declares the capability behavior (filter or
 * stamps); the `*ByDefault` context macro composes both via
 * `invokeMacro` for the "every aggregate in the context participates"
 * case.  Users pick the level they want — pure sugar over the
 * source-writable `filter` / `stamp` / `implements` surface. */
export function loadStdlibMacros(): void {
  if (_loaded) return;
  _loaded = true;
  // Audit trio
  registerMacro(audit);
  registerMacro(auditable);
  registerMacro(auditedByDefault);
  // Soft-delete trio
  registerMacro(softDelete);
  registerMacro(softDeletable);
  registerMacro(softDeleteByDefault);
  // Other capabilities
  registerMacro(crudish);
  registerMacro(scaffold);
}

/** Test/harness hook: allow tests that reset the registry to
 * re-register the stdlib without re-importing. */
export function _resetStdlibLoadFlag(): void {
  _loaded = false;
}
