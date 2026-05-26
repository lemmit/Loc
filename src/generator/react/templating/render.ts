// ---------------------------------------------------------------------------
// Render orchestrator for the template-pack rendering layer.
//
// The legacy archetype renderers (renderListPage,
// renderDetailPage, renderNewPage, renderViewTablePage,
// renderWorkflowForm, renderWorkflowsIndex, renderViewsIndex,
// renderOperationModal, renderPartTable) were deleted.  All page
// emission now routes through `body-walker.ts` driven by the
// walker-primitive expander in `src/ir/walker-primitive-expander.ts`.
//
// What remains:
//   - `renderShellFile`  — pack helper for project-shell files
//                          (api/client.ts, api/config.ts,
//                          src/lib/format.tsx, package.json,
//                          tsconfig.json, vite.config.ts).
//   - `renderTheme`      — `src/theme.ts` from the theme block.
//   - `renderAppShell`   — `src/App.tsx`.
//   - `renderMain`       — `src/main.tsx`.
//   - `renderHome`       — kept for callers that still want a
//                          `homeRenderer` callback shape; the
//                          scaffold expander now synthesises Home
//                          directly so this is rarely exercised.
//   - `renderFormField`  — drives the per-field input templates
//                          (`field-input-*.hbs`); used by the
//                          walker's `Form(of: <Agg>)` emission.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
  ThemeIR,
  ViewIR,
  WorkflowIR,
} from "../../../ir/loom-ir.js";
import type { LoadedPack } from "../../_packs/loader.js";
import { routerPackageForStack } from "../../_packs/stack-runtime.js";
import { prepareAppShellVM } from "./preparers/app-shell.js";
import { prepareThemeVM } from "./preparers/theme.js";
import type { FormFieldVM } from "./view-models.js";

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
  views: ViewIR[],
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
        routes: import("./preparers/app-shell.js").ExtraPageRoute[];
      }>
    | undefined = undefined,
  layoutImports: ReadonlyArray<{ specifier: string; from: string }> | undefined = undefined,
): string {
  return pack.render("app-shell", {
    ...prepareAppShellVM(
      aggs,
      workflows,
      views,
      systemName,
      sidebarOverride,
      extraRoutes,
      hasScaffoldHome,
      outOfShellRoutes,
      namedLayouts,
      layoutImports,
    ),
    // Router 7 (stack v3) renamed the package react-router-dom →
    // react-router; library mode keeps the v6 API so only the
    // import specifier changes.  Pre-v3 stacks resolve to
    // react-router-dom (byte-identical).
    routerPackage: routerPackageForStack(pack.manifest.stack),
  });
}

/** Render `src/main.tsx` — provider chain + React-Query client. */
export function renderMain(pack: LoadedPack): string {
  return pack.render("main", {
    routerPackage: routerPackageForStack(pack.manifest.stack),
  });
}

/** Render one form-field input through its per-pack
 *  `field-input-*` template.  Used by the walker's `Form(of:)` /
 *  `Form(runs:)` emission to produce one TSX block per field.
 *  Value-object fields recursively render their children and pass
 *  the joined HTML as `innerHtml` (the template variable the
 *  `field-input-valueobject.hbs` Fieldset reads). */
export function renderFormField(vm: FormFieldVM, pack: LoadedPack): string {
  if (vm.template === "field-input-valueobject") {
    const innerHtml = (vm.children ?? []).map((child) => renderFormField(child, pack)).join("\n");
    return pack.render(vm.template, { ...vm, innerHtml });
  }
  return pack.render(vm.template, vm);
}

// BoundedContextIR is re-exported below for callers that import
// it via this module — preserves the original import surface even
// though render.ts no longer needs it directly.
export type { BoundedContextIR };
