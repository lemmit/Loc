// Stdlib macro bundle.  Imported once at toolchain start to
// register every shipped macro into the global registry.

import { registerMacro } from "../registry.js";
import crudish from "./crudish.macro.js";
import scaffold from "./scaffold/scaffold.macro.js";
import scaffoldAggregate from "./scaffold/scaffoldAggregate.macro.js";
import scaffoldApi from "./scaffold/scaffoldApi.macro.js";
import scaffoldContext from "./scaffold/scaffoldContext.macro.js";
import scaffoldHandlers from "./scaffold/scaffoldHandlers.macro.js";
import scaffoldPaged from "./scaffold/scaffoldPaged.macro.js";
import scaffoldPagedApi from "./scaffold/scaffoldPagedApi.macro.js";
import scaffoldSubdomain from "./scaffold/scaffoldSubdomain.macro.js";
import scaffoldWorkflow from "./scaffold/scaffoldWorkflow.macro.js";
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
  // Audit is now the built-in `capability auditable` (src/macros/prelude.ts) —
  // the former audit/auditable/auditedByDefault macros were removed in the
  // typed-capabilities Phase 3 migration.
  // Soft-delete: state + filter is the built-in `capability softDeletable`
  // (src/macros/prelude.ts); `softDelete` (ops) + `softDeleteByDefault` stay
  // macros.  The former `softDeletable` (state) + `softDelete` (context filter)
  // macros were removed in the typed-capabilities Phase 3 migration.
  registerMacro(softDelete);
  registerMacro(softDeleteByDefault);
  // Other capabilities
  registerMacro(crudish);
  // Scaffold family: leaves + composers + top-level dispatcher.
  // Composability all the way: scaffold → scaffoldSubdomain →
  // scaffoldContext → scaffoldAggregate / Workflow.
  registerMacro(scaffoldAggregate);
  registerMacro(scaffoldWorkflow);
  registerMacro(scaffoldContext);
  registerMacro(scaffoldSubdomain);
  registerMacro(scaffold);
  // Explicit application/transport scaffolds (unfoldable-api-derivation.md, A3):
  // `scaffoldHandlers` (context) emits the commandHandlers; `scaffoldApi` (api)
  // emits the routes that bind to them.
  registerMacro(scaffoldHandlers);
  registerMacro(scaffoldApi);
  // Ergonomic paged criterion read (read-path-architecture.md, "The ergonomic
  // default"): `scaffoldPaged` (context) emits the paged queryHandler over the
  // read-only port (`Repo.run(<criterion>)`); `scaffoldPagedApi` (api) emits the
  // `/projections/<criterion>` route that binds to it.
  registerMacro(scaffoldPaged);
  registerMacro(scaffoldPagedApi);
}

/** Test/harness hook: allow tests that reset the registry to
 * re-register the stdlib without re-importing. */
export function _resetStdlibLoadFlag(): void {
  _loaded = false;
}
