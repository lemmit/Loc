// ---------------------------------------------------------------------------
// Render orchestrator for the template-pack rendering layer.
//
// Page emission routes through `body-walker.ts` (the shared markup walker);
// the previous archetype-based renderers were removed.  This module
// owns the project-shell and theme/app-shell renderers that sit
// alongside the body walker:
//
//   - `renderShellFile`  — pack helper for project-shell files
//                          (api/client.ts, api/config.ts,
//                          src/lib/format.tsx, package.json,
//                          tsconfig.json, vite.config.ts).
//   - `renderTheme`      — `src/theme.ts` from the theme block.
//   - `renderAppShell`   — `src/App.tsx`.
//   - `renderMain`       — `src/main.tsx`.
//   - `renderFormField`  — drives the per-field input templates
//                          (`field-input-*.hbs`); used by the
//                          walker's `CreateForm(of: <Agg>)` emission.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  ThemeIR,
  WorkflowIR,
} from "../../../ir/types/loom-ir.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { routerPackageForStack } from "../../_packs/stack-runtime.js";
import { prepareAppShellVM } from "./preparers/app-shell.js";
import { prepareThemeVM } from "./preparers/theme.js";

// renderFormField moved to src/generator/_walker/render-form-field.ts
// (shared by the walker's form primitives across frontends); re-export
// preserves this module's original surface.
export { renderFormField } from "../../_walker/render-form-field.js";

/** Render any pack-level "shell file" (project scaffolding outside
 *  the page-emission path).  Pack manifest's `emits` map names the
 *  template; `context` is passed verbatim to Handlebars. */
export function renderShellFile(name: string, context: unknown, pack: LoadedPack): string {
  return pack.render(name, context);
}

/** Render `src/theme.ts` from the system's theme block (or
 *  defaults when undefined). */
export function renderTheme(t: ThemeIR | undefined, pack: LoadedPack): string {
  return pack.render("theme", prepareThemeVM(t));
}

/** Render `src/App.tsx` — routing + provider chain + sidebar. */
export function renderAppShell(
  aggs: AggregateIR[],
  workflows: WorkflowIR[],
  systemName: string,
  sidebarOverride: import("./view-models.js").NavSectionVM[] | undefined,
  extraRoutes: import("./preparers/app-shell.js").ExtraPageRoute[] | undefined,
  pack: LoadedPack,
  hasScaffoldHome: boolean = true,
  outOfShellRoutes: import("./preparers/app-shell.js").ExtraPageRoute[] | undefined = undefined,
  /** Phase 8 step 2: pre-built named-layout VMs (slot JSX + route
   *  buckets), and the deduped pack imports those slots need. */
  namedLayouts:
    | ReadonlyArray<{
        name: string;
        hasHeader: boolean;
        headerJsx: string;
        hasSidebar: boolean;
        sidebarJsx: string;
        hasFooter: boolean;
        footerJsx: string;
        usesNavigate: boolean;
        routes: import("./preparers/app-shell.js").ExtraPageRoute[];
      }>
    | undefined = undefined,
  layoutImports: ReadonlyArray<{ specifier: string; from: string }> | undefined = undefined,
  /** Observable workflows (workflow-instance-visibility.md) — get read-only
   *  instance list/detail routes. */
  observableWorkflows: WorkflowIR[] = [],
  /** True when the ui declares `on <channel>.<Event>` live-event handlers
   *  and the realtime wire exists — App imports and mounts the renderless
   *  `<RealtimeHandlers />` component (channels.md Part I). */
  hasRealtimeHandlers = false,
  /** Whether a scaffold-synthesised `WorkflowsIndex` page
   *  exists — gates the `/workflows` index import+route so an
   *  explicit (non-scaffold) workflow page doesn't dangle against a
   *  missing index module.  Mirrors `hasScaffoldHome`. */
  hasWorkflowsIndex: boolean = true,
  /** Whether this react deployable is `auth: ui` (verified session claims
   *  available client-side).  Gates the menu-link `requires` hiding in the
   *  App-shell template — the `useSession`/`currentUser` binding + per-link
   *  `{requiresJs}` wrap are emitted only when true, so non-auth output stays
   *  byte-identical. */
  authUi = false,
): string {
  return pack.render("app-shell", {
    hasRealtimeHandlers,
    ...prepareAppShellVM(
      aggs,
      workflows,
      systemName,
      sidebarOverride,
      extraRoutes,
      hasScaffoldHome,
      outOfShellRoutes,
      namedLayouts,
      layoutImports,
      observableWorkflows,
      hasWorkflowsIndex,
      authUi,
    ),
    // Router 7 (stack v3) renamed the package react-router-dom →
    // react-router; library mode keeps the v6 API so only the
    // import specifier changes.  Pre-v3 stacks resolve to
    // react-router-dom (byte-identical).
    routerPackage: routerPackageForStack(pack.manifest.stack),
  });
}

/** Render `src/main.tsx` — provider chain + React-Query client.
 *  `basename` bakes the router basename fallback for sub-path hosts
 *  (Phoenix `/app`); omitted → the runtime `__LOOM_BASENAME__` hook
 *  still falls back to `undefined` (root), byte-identical. */
export function renderMain(pack: LoadedPack, basename?: string, authUi = false): string {
  return pack.render("main", {
    routerPackage: routerPackageForStack(pack.manifest.stack),
    basename,
    authUi,
  });
}

// BoundedContextIR is re-exported below for callers that import
// it via this module — preserves the original import surface even
// though render.ts no longer needs it directly.
export type { BoundedContextIR };
