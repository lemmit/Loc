import type { Workflow } from "../../api/index.js";
import { defineMacro } from "../../api/index.js";
import { pageForWorkflow, workflowIsEventTriggeredOnly } from "./_pages.js";

/** Synthesise the default form page for one workflow.  Leaf of
 * the scaffold-macro family. */
export default defineMacro({
  name: "scaffoldWorkflow",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises a Form page for the named workflow.  Leaf of the " +
    "scaffold-macro family — invoked by `scaffoldContext` / " +
    "`scaffoldSubdomain` / `scaffold` for each workflow they cover.",
  params: {
    of: { kind: "ref", of: "Workflow" },
  },
  expand({ args }) {
    const wf = args.of as Workflow;
    // An event-triggered-only workflow runs via the in-process dispatch
    // handlers, not an HTTP command — it has no form to submit.
    if (workflowIsEventTriggeredOnly(wf)) return [];
    return [pageForWorkflow(wf)];
  },
});
