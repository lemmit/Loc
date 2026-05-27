// Stdlib macro bundle.  Imported once at toolchain start to
// register every shipped macro into the global registry.

import { registerMacro } from "../registry.js";
import audit from "./audit/audit.macro.js";
import auditable from "./audit/auditable.macro.js";
import auditedByDefault from "./audit/auditedByDefault.macro.js";
import crudish from "./crudish.macro.js";
import scaffold from "./scaffold/scaffold.macro.js";
import scaffoldAggregate from "./scaffold/scaffoldAggregate.macro.js";
import scaffoldContext from "./scaffold/scaffoldContext.macro.js";
import scaffoldModule from "./scaffold/scaffoldModule.macro.js";
import scaffoldView from "./scaffold/scaffoldView.macro.js";
import scaffoldWorkflow from "./scaffold/scaffoldWorkflow.macro.js";
import softDeletable from "./softDelete/softDeletable.macro.js";
import softDelete from "./softDelete/softDelete.macro.js";
import softDeleteByDefault from "./softDelete/softDeleteByDefault.macro.js";

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
  // Scaffold family: leaves + composers + top-level dispatcher.
  // Composability all the way: scaffold → scaffoldModule →
  // scaffoldContext → scaffoldAggregate / Workflow / View.
  registerMacro(scaffoldAggregate);
  registerMacro(scaffoldWorkflow);
  registerMacro(scaffoldView);
  registerMacro(scaffoldContext);
  registerMacro(scaffoldModule);
  registerMacro(scaffold);
}

/** Test/harness hook: allow tests that reset the registry to
 * re-register the stdlib without re-importing. */
export function _resetStdlibLoadFlag(): void {
  _loaded = false;
}
