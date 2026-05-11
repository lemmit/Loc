// ---------------------------------------------------------------------------
// Batch C — non-aggregate scaffold archetype HEEx emitters.
//
// Each exported function mirrors the pattern in liveview-emit.ts's
// `renderPageHeex` for the aggregate archetypes: look up the domain IR,
// call the framework-neutral preparer, and call `pack.render(template, vm)`.
//
// These functions are intentionally decoupled from `liveview-emit.ts` so
// they can be integrated by the parent orchestrator without touching the
// existing file (constraint: do NOT modify liveview-emit.ts).
//
// Pack render errors are caught and returned as HEEx comments, mirroring
// the `safeRender` pattern in liveview-emit.ts.
// ---------------------------------------------------------------------------

import type {
  AggregateIR,
  BoundedContextIR,
} from "../../ir/loom-ir.js";
import type { LoadedPack } from "../react/templating/loader.js";
import { prepareWorkflowFormVM } from "../react/templating/preparers/workflow-form.js";
import { prepareViewTablePageVM } from "../react/templating/preparers/view-table.js";
import { prepareWorkflowsIndexVM } from "../react/templating/preparers/workflow-index.js";
import { prepareViewsIndexVM } from "../react/templating/preparers/views-index.js";
import { prepareHomeVM } from "../react/templating/preparers/home.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Wraps pack.render in a try/catch; on error returns a HEEx comment with
 *  the error message.  Mirrors `safeRender` in liveview-emit.ts. */
function safeRender(
  pack: LoadedPack,
  templateName: string,
  vm: unknown,
  label: string,
): string {
  try {
    return pack.render(templateName, vm);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `<!-- pack template '${templateName}' for '${label}' failed: ${msg.replace(/-->/g, "--&gt;")} -->`;
  }
}

// ---------------------------------------------------------------------------
// Workflow form
// ---------------------------------------------------------------------------

export interface RenderWorkflowFormHeexArgs {
  workflowName: string;
  contextName: string;
  contexts: BoundedContextIR[];
  aggregatesByName: Map<string, AggregateIR>;
  pack: LoadedPack;
}

/** Emit HEEx body for a `workflow-form` scaffold archetype page. */
export function renderWorkflowFormHeex(args: RenderWorkflowFormHeexArgs): string {
  const { workflowName, contextName, contexts, aggregatesByName, pack } = args;

  const ctx = contexts.find((c) => c.name === contextName);
  if (!ctx) {
    return `<!-- context '${contextName}' not found for workflow-form '${workflowName}' -->`;
  }
  const wf = ctx.workflows.find((w) => w.name === workflowName);
  if (!wf) {
    return `<!-- workflow '${workflowName}' not found in context '${contextName}' -->`;
  }

  const vm = prepareWorkflowFormVM(wf, ctx, aggregatesByName);
  return safeRender(pack, "workflow-form", vm, `workflow-form:${workflowName}`);
}

// ---------------------------------------------------------------------------
// View table
// ---------------------------------------------------------------------------

export interface RenderViewTableHeexArgs {
  viewName: string;
  contextName: string;
  contexts: BoundedContextIR[];
  aggregatesByName: Map<string, AggregateIR>;
  pack: LoadedPack;
}

/** Emit HEEx body for a `view-list` scaffold archetype page. */
export function renderViewTableHeex(args: RenderViewTableHeexArgs): string {
  const { viewName, contextName, contexts, aggregatesByName, pack } = args;

  const ctx = contexts.find((c) => c.name === contextName);
  if (!ctx) {
    return `<!-- context '${contextName}' not found for view-list '${viewName}' -->`;
  }
  const view = ctx.views.find((v) => v.name === viewName);
  if (!view) {
    return `<!-- view '${viewName}' not found in context '${contextName}' -->`;
  }

  const vm = prepareViewTablePageVM(view, ctx, aggregatesByName);
  return safeRender(pack, "view-table", vm, `view-table:${viewName}`);
}

// ---------------------------------------------------------------------------
// Workflows index
// ---------------------------------------------------------------------------

export interface RenderWorkflowsIndexHeexArgs {
  contexts: BoundedContextIR[];
  pack: LoadedPack;
}

/** Emit HEEx body for the `workflows-index` scaffold archetype page. */
export function renderWorkflowsIndexHeex(args: RenderWorkflowsIndexHeexArgs): string {
  const { contexts, pack } = args;
  const vm = prepareWorkflowsIndexVM(contexts);
  return safeRender(pack, "workflow-index", vm, "workflows-index");
}

// ---------------------------------------------------------------------------
// Views index
// ---------------------------------------------------------------------------

export interface RenderViewsIndexHeexArgs {
  contexts: BoundedContextIR[];
  pack: LoadedPack;
}

/** Emit HEEx body for the `views-index` scaffold archetype page. */
export function renderViewsIndexHeex(args: RenderViewsIndexHeexArgs): string {
  const { contexts, pack } = args;
  const vm = prepareViewsIndexVM(contexts);
  return safeRender(pack, "views-index", vm, "views-index");
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

export interface RenderHomeHeexArgs {
  contexts: BoundedContextIR[];
  sysName: string;
  pack: LoadedPack;
}

/** Emit HEEx body for the `home` scaffold archetype page. */
export function renderHomeHeex(args: RenderHomeHeexArgs): string {
  const { contexts, sysName, pack } = args;

  // Flatten all aggregates, workflows, views across contexts — same as the
  // React generator's home page preparer invocation site.
  const aggregates = contexts.flatMap((c) => c.aggregates);
  const workflows = contexts.flatMap((c) => c.workflows);
  const views = contexts.flatMap((c) => c.views);

  const vm = prepareHomeVM(aggregates, workflows, views, sysName);
  return safeRender(pack, "home", vm, "home");
}
