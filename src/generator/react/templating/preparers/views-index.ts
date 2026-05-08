// ---------------------------------------------------------------------------
// View-model preparer for the views index page.  Mirrors the legacy
// buildViewsIndexPage: a card per view with shape line + Open button.
// ---------------------------------------------------------------------------

import type { BoundedContextIR, ViewIR } from "../../../../ir/loom-ir.js";
import { humanize, snake } from "../../../../util/naming.js";
import type { ViewsIndexVM } from "../view-models.js";

export function prepareViewsIndexVM(
  contexts: BoundedContextIR[],
): ViewsIndexVM {
  const all: ViewIR[] = [];
  for (const ctx of contexts) {
    for (const v of ctx.views) all.push(v);
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  return {
    cards: all.map((view) => {
      const slug = snake(view.name);
      const shapeLine = view.output
        ? `Custom shape: ${view.output.fields.map((f) => f.name).join(", ")}`
        : `Source: ${view.aggregateName}`;
      return {
        slug,
        humanView: humanize(view.name),
        shapeLine,
      };
    }),
  };
}
