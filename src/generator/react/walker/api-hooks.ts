// Api-hook registration utility — React-walker-private.
//
// The detection logic (`tryDetectApiHook`) moved to the shared
// `src/generator/_walker/api-hook-detector.ts` so a future Vue /
// Svelte / Blazor frontend can reuse it verbatim; the React-specific
// naming logic (`useAll<Plural>`, `useCreate<Single>`, etc.) lives in
// `tsxTarget.buildHookUse` (`src/generator/react/walker/tsx-target.ts`).
//
// This file keeps only the in-context registration helper: a tiny
// `Map.set` that dedupes by varName.  Imported by `body-walker.ts`.

import type { ApiHookUse, WalkContext } from "../body-walker.js";

/** Register a detected hook usage on the walker context.  De-dupes
 *  by var name — if the same `<param>.<aggregate>.<op>` appears
 *  twice in the body, only one declaration is emitted at page-top. */
export function registerApiHook(hook: ApiHookUse, ctx: WalkContext): void {
  if (!ctx.usedApiHooks.has(hook.varName)) {
    ctx.usedApiHooks.set(hook.varName, hook);
  }
}
