import type { Workflow } from "../macro-api/index.js";
import { defineMacro } from "../macro-api/index.js";
import { pageForWorkflow } from "./_scaffold-pages.js";

/** Synthesise the default form page for one workflow.  Same shape
 * as `scaffold workflows: <Name>` in the legacy expander.  Leaf of
 * the scaffold-macro family. */
export default defineMacro({
  name: "scaffoldWorkflow",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises a Form page for the named workflow.  Leaf of the " +
    "scaffold-macro family — invoked by `scaffoldContext` / " +
    "`scaffoldModule` / `scaffold` for each workflow they cover.",
  params: {
    of: { kind: "ref", of: "Workflow" },
  },
  expand({ args }) {
    return [pageForWorkflow(args.of as Workflow)];
  },
});
