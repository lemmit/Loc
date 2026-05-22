// ---------------------------------------------------------------------------
// View-model preparer for App.tsx — the application shell that hosts
// the sidebar navigation, header bar, error boundary, and React
// Router routes.  Mirrors the legacy appTsx() in
// src/generator/react/index.ts: per-aggregate List/New/Detail page
// imports + matching routes; per-workflow form-page imports + routes;
// per-view table-page imports + routes; sidebar entries grouped by
// construct kind.
//
// The preparer's job is to flatten these decisions into typed
// arrays the template iterates.  Layout (AppShell sizing, header
// branding, breakpoint behaviour) lives in the template.
// ---------------------------------------------------------------------------

import type { AggregateIR, ViewIR, WorkflowIR } from "../../../../ir/loom-ir.js";
import { humanize, plural, snake } from "../../../../util/naming.js";
import type { AppShellVM, ImportVM, NavEntryVM, NavSectionVM, RouteVM } from "../view-models.js";

function pascal(s: string): string {
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
  views: ViewIR[],
  systemName: string,
  /** When the deployable's `ui:` block declares an explicit
   *  `menu { … }`, the caller derives `navSections` from that block
   *  (via `deriveSidebarFromUi`) and passes them here.  When
   *  undefined the legacy hardcoded grouping (Aggregates / Workflows /
   *  Views) is used — byte-equivalent to main's pre-Slice-6 output. */
  sidebarOverride?: NavSectionVM[],
  /** Explicit pages with non-conventional names emit
   *  at `src/pages/<name-snake>.tsx`.  The caller hands their
   *  import + route shape so App.tsx can import & route them
   *  alongside the conventional aggregate/workflow/view set.
   *  Routes are appended after the per-aggregate / -workflow /
   *  -view block so React Router matches conventional first. */
  extraRoutes?: ExtraPageRoute[],
): AppShellVM {
  const imports: ImportVM[] = [];
  const routes: RouteVM[] = [];

  // Home page — generator-synthesised landing, mounted at "/".
  // Skipped when an explicit `page` already claims route "/" (the
  // user's page wins; no synthesised Home file is emitted either,
  // so referencing one here would dangle).
  const userHasRootRoute = extraRoutes?.some((r) => r.route === "/") ?? false;
  if (!userHasRootRoute) {
    imports.push({ specifier: "Home", from: "./pages/home" });
    routes.push({ path: "/", elementJsx: "<Home />" });
  }

  // Per-aggregate pages.
  for (const agg of aggregates) {
    const slug = snake(plural(agg.name));
    const cap = pascal(agg.name);
    imports.push({ specifier: `${cap}List`, from: `./pages/${slug}/list` });
    imports.push({ specifier: `${cap}New`, from: `./pages/${slug}/new` });
    imports.push({ specifier: `${cap}Detail`, from: `./pages/${slug}/detail` });
    routes.push({ path: `/${slug}`, elementJsx: `<${cap}List />` });
    routes.push({ path: `/${slug}/new`, elementJsx: `<${cap}New />` });
    routes.push({ path: `/${slug}/:id`, elementJsx: `<${cap}Detail />` });
  }

  // Per-workflow pages — index + per-workflow form.
  if (workflows.length > 0) {
    imports.push({ specifier: "WorkflowsIndex", from: "./pages/workflows/index" });
    routes.push({ path: "/workflows", elementJsx: "<WorkflowsIndex />" });
    for (const wf of workflows) {
      const slug = snake(wf.name);
      const cap = `${pascal(wf.name)}WorkflowPage`;
      imports.push({ specifier: cap, from: `./pages/workflows/${slug}` });
      routes.push({ path: `/workflows/${slug}`, elementJsx: `<${cap} />` });
    }
  }

  // Per-view pages — index + per-view table.
  if (views.length > 0) {
    imports.push({ specifier: "ViewsIndex", from: "./pages/views/index" });
    routes.push({ path: "/views", elementJsx: "<ViewsIndex />" });
    for (const view of views) {
      const slug = snake(view.name);
      const cap = `${pascal(view.name)}ViewPage`;
      imports.push({ specifier: cap, from: `./pages/views/${slug}` });
      routes.push({ path: `/views/${slug}`, elementJsx: `<${cap} />` });
    }
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

  if (views.length > 0) {
    const entries: NavEntryVM[] = [];
    entries.push({
      to: "/views",
      label: "All views",
      testId: "nav-views",
      activeArgs: `"/views", { exact: true }`,
    });
    for (const view of views) {
      const slug = snake(view.name);
      entries.push({
        to: `/views/${slug}`,
        label: humanize(view.name),
        testId: `nav-view-${slug}`,
        activeArgs: JSON.stringify(`/views/${slug}`),
      });
    }
    navSections.push({ label: "Views", entries });
  }

  return {
    systemNameHuman: humanize(systemName),
    imports,
    routes,
    navSections: sidebarOverride ?? navSections,
  };
}
