// Macro registry.
//
// Holds the set of registered macros, keyed by name, and exposes
// lookup for the expander and validator.  Loaded from two sources:
//
//   1. The stdlib (`src/stdlib/index.ts`) — bundled with the
//      toolchain, always available.
//   2. Project-local `.loom/macros/*.js` modules — discovered
//      under the workspace root when the CLI/LSP boots.  Authors
//      write `.ts`; tsc emits `.js` next to it; the loader picks
//      up the compiled output.  This avoids any runtime
//      TypeScript dependency in the toolchain itself.
//
// Registration is process-global.  Per-workspace isolation (two
// open projects with different macro libraries) would require a
// per-services-container map.

import type { MacroDefinition } from "./api/define.js";

const registry = new Map<string, MacroDefinition>();

/** Register a macro.  Re-registration with the same name throws —
 * stdlib loads first, so a project-local macro that collides with
 * stdlib triggers an explicit error rather than silent override. */
export function registerMacro(def: MacroDefinition): void {
  if (registry.has(def.name)) {
    const existing = registry.get(def.name)!;
    throw new Error(
      `Macro '${def.name}' is already registered (target=${existing.target}); ` +
        `cannot register a second definition (target=${def.target}).`,
    );
  }
  registry.set(def.name, def);
}

/** Look up a macro by name.  Returns undefined for unknown names —
 * the validator surfaces this as a user-facing diagnostic. */
export function lookupMacro(name: string): MacroDefinition | undefined {
  return registry.get(name);
}

/** All registered macros, in registration order. */
export function allMacros(): readonly MacroDefinition[] {
  return Array.from(registry.values());
}

/** Test/harness hook: wipe the registry.  Stdlib re-registers
 * itself on next import; project-local macros need to be re-loaded
 * explicitly. */
export function _resetRegistryForTests(): void {
  registry.clear();
}
