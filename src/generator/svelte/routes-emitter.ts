// Page emitter — SvelteKit file-based routing edition.
//
// Walks `ui.pages` (post scaffold expansion) and emits one
// `+page.svelte` per routable page under `src/routes/…`, mapping the
// page metamodel's route strings + layout selectors onto SvelteKit's
// conventions:
//
//   route "/orders"        → src/routes/(app)/orders/+page.svelte
//   route "/orders/:id"    → src/routes/(app)/orders/[id]/+page.svelte
//   route "/"              → src/routes/(app)/+page.svelte
//   layout: none           → the (bare) group (root layout only — no chrome)
//   layout: <Name>         → the (app) group for now (named-layout
//                            parity is a follow-up slice; the page
//                            still renders inside the default chrome)
//
// Route groups `(app)` / `(bare)` don't contribute URL segments —
// the chrome lives at src/routes/(app)/+layout.svelte while the root
// layout owns the query-client provider + toaster, so `layout: none`
// pages skip the chrome but keep the app plumbing.
//
// Sibling of src/generator/react/pages-emitter.ts; the per-page
// module assembly lives in walker/page-shell.ts.

import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  DeployableIR,
  PageIR,
  ParamIR,
  SystemIR,
  UiIR,
  WorkflowIR,
} from "../../ir/types/loom-ir.js";
import { plural, snake } from "../../util/naming.js";
import type { LoadedPack } from "../_packs/loader.js";
import { isWalkableLayoutBody } from "../_walker/walker-core.js";
import { renderSvelteComponentFile, renderSveltePage } from "./walker/page-shell.js";

export interface SveltePageEmitContext {
  sys: SystemIR;
  deployable: DeployableIR;
  aggregatesByName: Map<string, AggregateIR>;
  contextsByName: Map<string, BoundedContextIR>;
  pack: LoadedPack;
  topLevelComponents: readonly ComponentIR[];
}

/** Translate a page-metamodel route to a SvelteKit route directory
 *  (no group segment).  `:param` segments become `[param]`; the root
 *  route maps to the group directory itself. */
export function routeToKitDir(route: string): string {
  const segs = route.split("/").filter((s) => s.length > 0);
  return segs.map((s) => (s.startsWith(":") ? `[${s.slice(1)}]` : s)).join("/");
}

/** The route group a page's layout selector maps to. */
function groupForLayout(page: PageIR): string {
  if (page.layout?.kind === "preset" && page.layout.name === "none") return "(bare)";
  return "(app)";
}

/** Emit path for a routable page. */
export function sveltePagePath(page: PageIR): string | undefined {
  if (!page.route) return undefined;
  const dir = routeToKitDir(page.route);
  const group = groupForLayout(page);
  return dir === ""
    ? `src/routes/${group}/+page.svelte`
    : `src/routes/${group}/${dir}/+page.svelte`;
}

function buildBcByAggregate(ctx: SveltePageEmitContext): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const agg of bc.aggregates) out.set(agg.name, bc);
  }
  return out;
}

function buildWorkflowsByName(ctx: SveltePageEmitContext): Map<string, WorkflowIR> {
  const out = new Map<string, WorkflowIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, wf);
  }
  return out;
}

function buildBcByWorkflow(ctx: SveltePageEmitContext): Map<string, BoundedContextIR> {
  const out = new Map<string, BoundedContextIR>();
  for (const bc of ctx.contextsByName.values()) {
    for (const wf of bc.workflows) out.set(wf.name, bc);
  }
  return out;
}

export function emitSveltePagesForUi(ui: UiIR, ctx: SveltePageEmitContext): Map<string, string> {
  const out = new Map<string, string>();

  const userComponents = new Map<string, readonly ParamIR[]>();
  for (const c of ctx.topLevelComponents) userComponents.set(c.name, c.params);
  for (const c of ui.components) userComponents.set(c.name, c.params);
  const pageRoutes = new Map<string, string>();
  for (const page of ui.pages) {
    if (page.route) pageRoutes.set(page.name, page.route);
  }

  // User components — `src/lib/components/<Name>.svelte`, ui-scope
  // shadowing top-level on name collision.  Extern components are a
  // follow-up parity slice for svelte; surface loudly rather than
  // emit a broken import.
  const emittedComponents = new Map<string, ComponentIR>();
  for (const c of ctx.topLevelComponents) emittedComponents.set(c.name, c);
  for (const c of ui.components) emittedComponents.set(c.name, c);
  for (const c of emittedComponents.values()) {
    if (c.extern) {
      throw new Error(
        `svelte: extern component '${c.name}' — the extern-component escape hatch is not wired for the svelte platform yet (docs/plans/svelte-frontend-plan.md).`,
      );
    }
    out.set(
      `src/lib/components/${c.name}.svelte`,
      renderSvelteComponentFile(
        c.name,
        [...c.params],
        c.state,
        c.body!,
        ctx.pack,
        userComponents,
        ctx.aggregatesByName,
        buildBcByAggregate(ctx),
        pageRoutes,
      ),
    );
  }

  const seenPaths = new Map<string, string>();
  for (const page of ui.pages) {
    if (!isWalkableLayoutBody(page.body, userComponents)) continue;
    const emitPath = sveltePagePath(page);
    if (!emitPath) continue;
    const prior = seenPaths.get(emitPath);
    if (prior) {
      throw new Error(
        `svelte: pages '${prior}' and '${page.name}' both route to ${emitPath} — SvelteKit file routing needs distinct routes per page.`,
      );
    }
    seenPaths.set(emitPath, page.name);
    out.set(
      emitPath,
      renderSveltePage(
        page.name,
        page.body!,
        ctx.pack,
        page.params,
        page.state,
        page.title,
        userComponents,
        ui.apiParams,
        ctx.aggregatesByName,
        buildBcByAggregate(ctx),
        buildWorkflowsByName(ctx),
        buildBcByWorkflow(ctx),
        pageRoutes,
      ),
    );
  }
  return out;
}

/** Nav-entry data for the app-shell template — the default grouped
 *  sidebar (Aggregates / Workflows / Views) mirroring the react
 *  shell's hardcoded grouping, overridden by an explicit `ui.menu`
 *  via the shared `deriveSidebarFromUi`. */
export function defaultNavSections(
  scaffoldedAggregates: readonly AggregateIR[],
  scaffoldedWorkflows: readonly WorkflowIR[],
  scaffoldedViewNames: readonly string[],
  hasWorkflowsIndex: boolean,
  hasViewsIndex: boolean,
): Array<{ label: string; entries: Array<{ to: string; label: string; testId: string }> }> {
  const sections: Array<{
    label: string;
    entries: Array<{ to: string; label: string; testId: string }>;
  }> = [];
  if (scaffoldedAggregates.length > 0) {
    sections.push({
      label: "Aggregates",
      entries: scaffoldedAggregates.map((a) => {
        const slug = snake(plural(a.name));
        return { to: `/${slug}`, label: plural(a.name), testId: `nav-${slug}` };
      }),
    });
  }
  const wfEntries: Array<{ to: string; label: string; testId: string }> = [];
  if (hasWorkflowsIndex) {
    wfEntries.push({ to: "/workflows", label: "All workflows", testId: "nav-workflows" });
  }
  for (const wf of scaffoldedWorkflows) {
    wfEntries.push({
      to: `/workflows/${snake(wf.name)}`,
      label: wf.name,
      testId: `nav-workflow-${snake(wf.name)}`,
    });
  }
  if (wfEntries.length > 0) sections.push({ label: "Workflows", entries: wfEntries });
  const viewEntries: Array<{ to: string; label: string; testId: string }> = [];
  if (hasViewsIndex) {
    viewEntries.push({ to: "/views", label: "All views", testId: "nav-views" });
  }
  for (const v of scaffoldedViewNames) {
    viewEntries.push({ to: `/views/${snake(v)}`, label: v, testId: `nav-view-${snake(v)}` });
  }
  if (viewEntries.length > 0) sections.push({ label: "Views", entries: viewEntries });
  return sections;
}

