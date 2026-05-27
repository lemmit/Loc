import type { Aggregate, BoundedContext, Module, View, Workflow } from "../../api/index.js";
import { defineMacro, viewsIn, workflowsIn } from "../../api/index.js";
import { homePage, viewsIndexPage, workflowsIndexPage } from "./_pages.js";

/** Top of the scaffold-macro family: takes any combination of
 * modules / contexts / aggregates / workflows / views, then fans
 * out to the per-element composers (`scaffoldModule`,
 * `scaffoldContext`) and leaves (`scaffoldAggregate`,
 * `scaffoldWorkflow`, `scaffoldView`) via `invokeMacro`.
 *
 * Composability all the way down.  Unfold one level on
 * `with scaffold(modules: [Sales])` reveals
 * `with scaffoldModule(of: Sales)`; unfold that to get
 * per-context, per-aggregate macros; unfold a single
 * `scaffoldAggregate` to materialise just its three pages as
 * source so you can customise them while leaving the rest of the
 * UI under the macro.
 *
 * The shared singleton pages — Home, WorkflowsIndex, ViewsIndex —
 * stay as direct emissions here because they're emitted once per
 * UI regardless of what's being scaffolded.  Override-by-name lets
 * the user replace any of them by writing the page explicitly. */
export default defineMacro({
  name: "scaffold",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises default List/Detail/New pages for the listed aggregates, " +
    "form pages for workflows, and list pages for views.  Composes via " +
    "`invokeMacro` so unfolding reveals per-element scaffold macros that " +
    "can be drilled into individually.",
  params: {
    aggregates: { kind: "refList", of: "Aggregate" },
    workflows: { kind: "refList", of: "Workflow" },
    views: { kind: "refList", of: "View" },
    contexts: { kind: "refList", of: "BoundedContext" },
    modules: { kind: "refList", of: "Module" },
  },
  expand({ target, args, invokeMacro }) {
    const out: unknown[] = [];

    for (const m of args.modules as readonly Module[]) {
      out.push(...invokeMacro("scaffoldModule", { target, args: { of: m } }));
    }
    for (const c of args.contexts as readonly BoundedContext[]) {
      out.push(...invokeMacro("scaffoldContext", { target, args: { of: c } }));
    }
    for (const a of args.aggregates as readonly Aggregate[]) {
      out.push(...invokeMacro("scaffoldAggregate", { target, args: { of: a } }));
    }
    for (const w of args.workflows as readonly Workflow[]) {
      out.push(...invokeMacro("scaffoldWorkflow", { target, args: { of: w } }));
    }
    for (const v of args.views as readonly View[]) {
      out.push(...invokeMacro("scaffoldView", { target, args: { of: v } }));
    }

    // Shared singleton pages — conditional on what's scaffolded so
    // we don't pollute the menu with empty WorkflowsIndex /
    // ViewsIndex links.  Computed from args (not from `out.length`,
    // which is 0 in unfold mode because invokeMacro returns []).
    const modules = args.modules as readonly Module[];
    const contexts = args.contexts as readonly BoundedContext[];
    const hasAnyWork =
      modules.length +
        contexts.length +
        (args.aggregates as readonly Aggregate[]).length +
        (args.workflows as readonly Workflow[]).length +
        (args.views as readonly View[]).length >
      0;
    if (hasAnyWork) out.push(homePage());
    const hasWorkflowsAnywhere =
      (args.workflows as readonly Workflow[]).length > 0 ||
      contexts.some((c) => workflowsIn(c).length > 0) ||
      modules.some((m) => workflowsIn(m).length > 0);
    if (hasWorkflowsAnywhere) out.push(workflowsIndexPage());
    const hasViewsAnywhere =
      (args.views as readonly View[]).length > 0 ||
      contexts.some((c) => viewsIn(c).length > 0) ||
      modules.some((m) => viewsIn(m).length > 0);
    if (hasViewsAnywhere) out.push(viewsIndexPage());

    return out as never[];
  },
});
