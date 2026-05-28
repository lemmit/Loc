import type { View } from "../../api/index.js";
import { defineMacro } from "../../api/index.js";
import { pageForView } from "./_pages.js";

/** Synthesise the default list page for one view.  Leaf of the
 * scaffold-macro family. */
export default defineMacro({
  name: "scaffoldView",
  target: "ui",
  apiVersion: 1,
  description:
    "Synthesises a List page for the named view.  Leaf of the scaffold-macro " +
    "family — invoked by `scaffoldContext` / `scaffoldSubdomain` / `scaffold` " +
    "for each view they cover.",
  params: {
    of: { kind: "ref", of: "View" },
  },
  expand({ args }) {
    return [pageForView(args.of as View)];
  },
});
