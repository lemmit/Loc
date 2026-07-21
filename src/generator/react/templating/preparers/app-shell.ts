// ---------------------------------------------------------------------------
// View-model preparer for App.tsx — the application shell that hosts
// the sidebar navigation, header bar, error boundary, and React
// Router routes.  Produces per-aggregate List/New/Detail page imports
// + matching routes, per-workflow form-page imports + routes, and
// sidebar entries grouped by construct kind.
//
// The preparer's job is to flatten these decisions into typed
// arrays the template iterates.  Layout (AppShell sizing, header
// branding, breakpoint behaviour) lives in the template.
// ---------------------------------------------------------------------------

import { emitsRestCreate } from "../../../../ir/enrich/wire-projection.js";
import type { AggregateIR, WorkflowIR } from "../../../../ir/types/loom-ir.js";
import { humanize, plural, snake } from "../../../../util/naming.js";
import type { AppShellVM, ImportVM, NavEntryVM, NavSectionVM, RouteVM } from "../view-models.js";

function upperFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

/** Extra Routes / imports for explicit pages with
 *  non-conventional routes.  Each entry is a flat record because
 *  the AppShell preparer doesn't pull in the page-IR module. */
export interface ExtraPageRoute {
  /** Page name in PascalCase — used as the React-component import
   *  specifier and as the JSX element name in the Route entry. */
  componentName: string;
  /** Module path relative to `src/`, no extension —
   *  e.g. `"./pages/order_console"`. */
  importFrom: string;
  /** Route path verbatim — e.g. `"/customers/:customerId/orders"`. */
  route: string;
}

export function prepareAppShellVM(
  aggregates: AggregateIR[],
  workflows: WorkflowIR[],
  systemName: string,
  /** When the deployable's `ui:` block declares an explicit
   *  `menu { … }`, the caller derives `navSections` from that block
   *  (via `deriveSidebarFromUi`) and passes them here.  When
   *  undefined the default hardcoded grouping (Aggregates / Workflows)
   *  is used. */
  sidebarOverride?: NavSectionVM[],
  /** Explicit pages with non-conventional names emit
   *  at `src/pages/<name-snake>.tsx`.  The caller hands their
   *  import + route shape so App.tsx can import & route them
   *  alongside the conventional aggregate/workflow set.
   *  Routes are appended after the per-aggregate / -workflow
   *  block so React Router matches conventional first. */
  extraRoutes?: ExtraPageRoute[],
  /** Whether the ui's scaffold expander produced a synthesised
   *  `Home` page.  When false the import is skipped to avoid a
   *  dangling reference (explicit-page-only uis emit no Home file).
   *  Default true is the safe assumption for callers without a ui. */
  hasScaffoldHome: boolean = true,
  /** Explicit pages with `layout: none` — mounted OUTSIDE the
   *  AppShell chrome as sibling routes to the layout-route.
   *  Imports go into the shared `imports` channel so each component
   *  appears once regardless of which shell branch routes it.
   *  Phoenix LiveView ignores this channel today. */
  outOfShellRoutes?: ExtraPageRoute[],
  /** Phase 8 step 2: pre-built named-layout VMs from `layouts-emitter.ts`.
   *  Each entry already has its slot JSX walked + its route bucket
   *  populated.  The preparer flattens the per-entry routes into
   *  `RouteVM[]` and threads the VM list into `AppShellVM.namedLayouts`
   *  for the template to iterate. */
  namedLayouts?: ReadonlyArray<{
    name: string;
    hasHeader: boolean;
    headerJsx: string;
    hasSidebar: boolean;
    sidebarJsx: string;
    hasFooter: boolean;
    footerJsx: string;
    usesNavigate: boolean;
    routes: ExtraPageRoute[];
  }>,
  /** Phase 8 step 2: extra imports the named-layout JSX needs.
   *  Already deduped by the layouts-emitter; the preparer appends
   *  them to the shared `imports` list. */
  layoutImports?: ReadonlyArray<{ specifier: string; from: string }>,
  /** Observable workflows (workflow-instance-visibility.md) — those whose
   *  scaffold synthesised read-only instance pages.  Each gets a list route
   *  (`/workflows/<slug>/instances`) + a detail route
   *  (`/workflows/<slug>/instances/:id`).  Distinct from `workflows` (the
   *  form set): an event-triggered-only saga appears here but not there. */
  observableWorkflows: WorkflowIR[] = [],
  /** Whether a scaffold-synthesised `WorkflowsIndex` page (origin
   *  `workflows-index`) exists.  When false — an explicit workflow page
   *  with no scaffold — the `/workflows` index import+route is skipped to
   *  avoid a dangling `./pages/workflows/index` reference; the per-workflow
   *  pages still mount.  Mirrors `hasScaffoldHome`.  Default true is the
   *  safe assumption for callers without a ui. */
  hasWorkflowsIndex: boolean = true,
  /** Whether the deployable is `auth: ui` — the verified session user is
   *  available client-side.  Surfaced verbatim on the VM as `authUi` so the
   *  App-shell template can bind `currentUser = useSession().user` and wrap
   *  menu links that carry a `requiresJs` gate.  The default hardcoded sidebar
   *  entries (aggregates/workflows) are scaffold pages with no
   *  `requires`, so they never carry `requiresJs` and stay ungated; only the
   *  `sidebarOverride` (menu-derived) entries can be gated. */
  authUi: boolean = false,
): AppShellVM {
  const imports: ImportVM[] = [];
  const routes: RouteVM[] = [];

  // Home page — generator-synthesised landing, mounted at "/".
  // Skipped when an explicit `page` already claims route "/" (the
  // user's page wins; no synthesised Home file is emitted either,
  // so referencing one here would dangle), OR when the ui declared
  // no scaffold so the scaffold expander never synthesised Home.
  const userHasRootRoute = extraRoutes?.some((r) => r.route === "/") ?? false;
  if (!userHasRootRoute && hasScaffoldHome) {
    imports.push({ specifier: "Home", from: "./pages/home" });
    routes.push({ path: "/", elementJsx: "<Home />" });
  }

  // Per-aggregate pages.
  for (const agg of aggregates) {
    const slug = snake(plural(agg.name));
    const cap = upperFirst(agg.name);
    // The `New` page (scaffold create form) is dropped for a read-only
    // aggregate with no REST create surface — `dropNonConstructibleNewPages`
    // removes it from `ui.pages` on exactly `!emitsRestCreate`, so no
    // `pages/<slug>/new` file is emitted.  Gate its import + route on the same
    // fact, else App.tsx imports a module that doesn't exist (tsc TS2307).
    const hasNew = emitsRestCreate(agg);
    imports.push({ specifier: `${cap}List`, from: `./pages/${slug}/list` });
    if (hasNew) imports.push({ specifier: `${cap}New`, from: `./pages/${slug}/new` });
    imports.push({ specifier: `${cap}Detail`, from: `./pages/${slug}/detail` });
    routes.push({ path: `/${slug}`, elementJsx: `<${cap}List />` });
    if (hasNew) routes.push({ path: `/${slug}/new`, elementJsx: `<${cap}New />` });
    routes.push({ path: `/${slug}/:id`, elementJsx: `<${cap}Detail />` });
  }

  // Per-workflow pages — index (only when the scaffold synthesised one)
  // + per-workflow form.
  if (workflows.length > 0) {
    if (hasWorkflowsIndex) {
      imports.push({ specifier: "WorkflowsIndex", from: "./pages/workflows/index" });
      routes.push({ path: "/workflows", elementJsx: "<WorkflowsIndex />" });
    }
    for (const wf of workflows) {
      const slug = snake(wf.name);
      const cap = `${upperFirst(wf.name)}WorkflowPage`;
      imports.push({ specifier: cap, from: `./pages/workflows/${slug}` });
      routes.push({ path: `/workflows/${slug}`, elementJsx: `<${cap} />` });
    }
  }

  // Per-observable-workflow instance pages (workflow-instance-visibility.md):
  // read-only list + detail over a saga's correlation-state rows.  Default
  // imports (local name = component) keep the page-name → module mapping; an
  // event-triggered-only saga is routed here even with no form page above.
  for (const wf of observableWorkflows) {
    const slug = snake(wf.name);
    const cap = upperFirst(wf.name);
    imports.push({ specifier: `${cap}InstancesList`, from: `./pages/workflows/${slug}/instances` });
    imports.push({
      specifier: `${cap}InstanceDetail`,
      from: `./pages/workflows/${slug}/instance_detail`,
    });
    routes.push({ path: `/workflows/${slug}/instances`, elementJsx: `<${cap}InstancesList />` });
    routes.push({
      path: `/workflows/${slug}/instances/:id`,
      elementJsx: `<${cap}InstanceDetail />`,
    });
  }

  // Explicit pages with non-conventional names.
  // Mounted AFTER the conventional set so React Router matches
  // the conventional routes first when a user-supplied custom
  // route happens to start with `/orders` etc.  The preparer
  // doesn't dedupe — caller is responsible for not handing the
  // same component twice.
  for (const extra of extraRoutes ?? []) {
    imports.push({
      specifier: extra.componentName,
      from: extra.importFrom,
    });
    routes.push({
      path: extra.route,
      elementJsx: `<${extra.componentName} />`,
    });
  }

  // Pages with `layout: none` — same import shape as the in-shell
  // extras, routed via a separate channel that the template emits
  // OUTSIDE the AppShell layout-route.  Imports live in the
  // shared list so each component module is imported exactly
  // once even if a future extension routes a single page through
  // both channels.
  const outOfShellRoutesVM: RouteVM[] = [];
  for (const extra of outOfShellRoutes ?? []) {
    imports.push({
      specifier: extra.componentName,
      from: extra.importFrom,
    });
    outOfShellRoutesVM.push({
      path: extra.route,
      elementJsx: `<${extra.componentName} />`,
    });
  }

  // Sidebar nav sections.  Each construct kind contributes at most
  // one section, omitted entirely when its entry list is empty.
  const navSections: NavSectionVM[] = [];

  navSections.push({
    label: "Aggregates",
    entries: aggregates.map((a) => {
      const slug = snake(plural(a.name));
      const entry: NavEntryVM = {
        to: `/${slug}`,
        label: humanize(plural(a.name)),
        testId: `nav-${slug}`,
        activeArgs: JSON.stringify(`/${slug}`),
      };
      return entry;
    }),
  });

  if (workflows.length > 0) {
    const entries: NavEntryVM[] = [];
    // Index link first, exact-match so /workflows/<slug> children
    // don't shadow the parent.
    entries.push({
      to: "/workflows",
      label: "All workflows",
      testId: "nav-workflows",
      activeArgs: `"/workflows", { exact: true }`,
    });
    for (const wf of workflows) {
      const slug = snake(wf.name);
      entries.push({
        to: `/workflows/${slug}`,
        label: humanize(wf.name),
        testId: `nav-workflow-${slug}`,
        activeArgs: JSON.stringify(`/workflows/${slug}`),
      });
    }
    navSections.push({ label: "Workflows", entries });
  }

  // Phase 8 step 2 — flatten the pre-walked named-layout VMs into
  // the AppShellVM channel + extend the import list.  Routes inside
  // a named layout are routed via `<Route element={<NameLayout />}>
  // <Route .../>… </Route>` in the template; the page-component
  // imports for those routes are appended to the shared `imports`
  // list (so e.g. `<Home />` resolves regardless of which channel
  // routes it).
  const namedLayoutsVM = (namedLayouts ?? []).map((nl) => ({
    name: nl.name,
    hasHeader: nl.hasHeader,
    headerJsx: nl.headerJsx,
    hasSidebar: nl.hasSidebar,
    sidebarJsx: nl.sidebarJsx,
    hasFooter: nl.hasFooter,
    footerJsx: nl.footerJsx,
    usesNavigate: nl.usesNavigate,
    routes: nl.routes.map((r) => ({
      path: r.route,
      elementJsx: `<${r.componentName} />`,
    })),
  }));
  for (const nl of namedLayouts ?? []) {
    for (const route of nl.routes) {
      imports.push({ specifier: route.componentName, from: route.importFrom });
    }
  }
  for (const imp of layoutImports ?? []) imports.push(imp);

  const finalNavSections = sidebarOverride ?? navSections;
  // The App-shell binds the session user only when at least one nav entry is
  // actually gated — binding it under bare `authUi` (with no gated link) would
  // leave `currentUser` + the `useSession` import unused, which the generated
  // project's Biome config rejects as an error.
  const navUsesSession = finalNavSections.some((s) => s.entries.some((e) => !!e.requiresJs));

  return {
    systemNameHuman: humanize(systemName),
    imports,
    routes,
    outOfShellRoutes: outOfShellRoutesVM,
    namedLayouts: namedLayoutsVM,
    hasNamedLayouts: namedLayoutsVM.length > 0,
    anyLayoutUsesNavigate: namedLayoutsVM.some((nl) => nl.usesNavigate),
    navSections: finalNavSections,
    authUi,
    navUsesSession,
  };
}
