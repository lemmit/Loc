// ---------------------------------------------------------------------------
// Frontend host → generator dispatch.
//
// A frontend platform is a static-asset HOST: it serves whatever framework the
// bound `ui` declares (`framework:`), not the framework its platform keyword is
// named after — a `platform: react` host can serve a `framework: vue` ui, since
// any static bundle runs on any static host (`STATIC_BUNDLE_FRAMEWORKS`).  The
// host's `emitProject` must therefore dispatch by `deployable.uiFramework` to
// the matching generator, or it silently emits its own framework instead (the
// bug B19 fixes — `vue.ts` had no dispatch at all).
//
// This map is the SINGLE dispatch source every host reuses; its keys are pinned
// to `STATIC_BUNDLE_FRAMEWORKS` by `frontend-dispatch.test.ts`, so a descriptor
// can't advertise (`hostableFrameworks`) a framework no host can emit, and a
// newly-added static frontend can't silently regress the matrix.
// ---------------------------------------------------------------------------

import { generateAngularForContexts } from "../generator/angular/index.js";
import { generateReactForContexts } from "../generator/react/index.js";
import { generateSvelteForContexts } from "../generator/svelte/index.js";
import { generateVueForContexts } from "../generator/vue/index.js";
import type {
  ComponentIR,
  DeployableIR,
  EnrichedBoundedContextIR,
  SystemIR,
} from "../ir/types/loom-ir.js";

/** The subset of `emitProject`'s args a frontend generator consumes. */
export interface FrontendEmitArgs {
  contexts: EnrichedBoundedContextIR[];
  sys: SystemIR;
  deployable: DeployableIR;
  topLevelComponents?: ComponentIR[];
}

type FrontendGenerator = (args: FrontendEmitArgs) => Map<string, string>;

const forward =
  (
    gen: (
      contexts: EnrichedBoundedContextIR[],
      sys: SystemIR,
      deployable: DeployableIR,
      options: { topLevelComponents?: ComponentIR[] },
    ) => Map<string, string>,
  ): FrontendGenerator =>
  (a) =>
    gen(a.contexts, a.sys, a.deployable, { topLevelComponents: a.topLevelComponents });

/** Framework keyword → its project generator.  `static` is React's UI-only
 *  alias (the same Vite-built bundle).  Kept in lockstep with
 *  `STATIC_BUNDLE_FRAMEWORKS` by the conformance test. */
export const FRONTEND_GENERATORS: Readonly<Record<string, FrontendGenerator>> = {
  react: forward(generateReactForContexts),
  static: forward(generateReactForContexts),
  svelte: forward(generateSvelteForContexts),
  vue: forward(generateVueForContexts),
  angular: forward(generateAngularForContexts),
};

/** Dispatch a frontend host's `emitProject` to the generator for the ui's
 *  `framework:`.  `fallback` is the host's own framework key, used only when
 *  the deployable declares no ui framework (a host with no ui mount) or an
 *  unrecognised one — so the host degrades to emitting its native framework
 *  rather than crashing. */
export function dispatchFrontendProject(
  framework: string | undefined,
  fallback: keyof typeof FRONTEND_GENERATORS,
  args: FrontendEmitArgs,
): Map<string, string> {
  const gen =
    (framework ? FRONTEND_GENERATORS[framework] : undefined) ?? FRONTEND_GENERATORS[fallback];
  return gen(args);
}
