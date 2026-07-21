import type { Aggregate, BoundedContext, Subdomain, Workflow } from "../../api/index.js";
import { aggregatesIn, defineMacro, workflowsIn } from "../../api/index.js";
import { homePage, workflowIsEventTriggeredOnly, workflowsIndexPage } from "./_pages.js";

/** Top of the scaffold-macro family: takes any combination of
 * subdomains / contexts / aggregates / workflows, then fans
 * out to the per-element composers (`scaffoldSubdomain`,
 * `scaffoldContext`) and leaves (`scaffoldAggregate`,
 * `scaffoldWorkflow`) via `invokeMacro`.
 *
 * Composability all the way down.  Unfold one level on
 * `with scaffold(subdomains: [Sales])` reveals
 * `with scaffoldSubdomain(of: Sales)`; unfold that to get
 * per-context, per-aggregate macros; unfold a single
 * `scaffoldAggregate` to materialise just its three pages as
 * source so you can customise them while leaving the rest of the
 * UI under the macro.
 *
 * The shared singleton pages — Home, WorkflowsIndex —
 * stay as direct emissions here because they're emitted once per
 * UI regardless of what's being scaffolded.  Override-by-name lets
 * the user replace any of them by writing the page explicitly. */
export default defineMacro({
  name: "scaffold",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises default List/Detail/New pages for the listed aggregates and " +
    "form pages for workflows.  Composes via " +
    "`invokeMacro` so unfolding reveals per-element scaffold macros that " +
    "can be drilled into individually.",
  params: {
    aggregates: { kind: "refList", of: "Aggregate" },
    workflows: { kind: "refList", of: "Workflow" },
    contexts: { kind: "refList", of: "BoundedContext" },
    subdomains: { kind: "refList", of: "Subdomain" },
  },
  expand({ target, args, invokeMacro }) {
    const out: unknown[] = [];

    for (const m of args.subdomains as readonly Subdomain[]) {
      out.push(...invokeMacro("scaffoldSubdomain", { target, args: { of: m } }));
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

    // Shared singleton dashboard pages.  These are ordinary scaffold pages now:
    // each macro builds its full body inline from the gathered inventory (no
    // deferred sentinel).  The inventory is everything this `scaffold` covers —
    // its direct ref-list args plus the aggregates/workflows inside any
    // scaffolded contexts/subdomains.
    const subdomains = args.subdomains as readonly Subdomain[];
    const contexts = args.contexts as readonly BoundedContext[];
    const allAggregates = [
      ...(args.aggregates as readonly Aggregate[]),
      ...contexts.flatMap((c) => aggregatesIn(c)),
      ...subdomains.flatMap((m) => aggregatesIn(m)),
    ];
    const allWorkflows = [
      ...(args.workflows as readonly Workflow[]),
      ...contexts.flatMap((c) => workflowsIn(c)),
      ...subdomains.flatMap((m) => workflowsIn(m)),
    ];
    // Gate Home on the args (not the expanded inventory) so a `scaffold` over an
    // empty context still gets a landing page, matching prior behaviour.
    const hasAnyWork =
      subdomains.length +
        contexts.length +
        (args.aggregates as readonly Aggregate[]).length +
        (args.workflows as readonly Workflow[]).length >
      0;
    if (hasAnyWork) {
      out.push(
        homePage({
          aggregates: allAggregates.length,
          // The Home "N workflows" card counts only command-surfaced workflows
          // (an event-triggered-only saga has no `/workflows/<wf>` route).
          workflows: allWorkflows.filter((w) => !workflowIsEventTriggeredOnly(w)).length,
        }),
      );
    }
    // The WorkflowsIndex singleton (and its menu link) is emitted only when at
    // least one command-surfaced workflow exists — a context of purely
    // event-triggered sagas would otherwise produce an empty index linking
    // nowhere.  Its cards list every workflow, matching the prior expander.
    if (allWorkflows.some((w) => !workflowIsEventTriggeredOnly(w))) {
      out.push(workflowsIndexPage(allWorkflows));
    }

    return out as never[];
  },
});
