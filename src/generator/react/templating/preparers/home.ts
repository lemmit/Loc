// ---------------------------------------------------------------------------
// View-model preparer for the home (landing) page.  Mirrors the
// legacy homeTsx() in src/generator/react/index.ts: a SimpleGrid
// of summary cards keyed by construct kind, each showing a count
// and a link to the matching index.  Counts are computed at gen
// time so the template renders fixed numbers — no runtime
// pluralisation logic in templates.
// ---------------------------------------------------------------------------

import type { AggregateIR, ViewIR, WorkflowIR } from "../../../../ir/loom-ir.js";
import { humanize, plural, snake } from "../../../../util/naming.js";
import type { HomeVM } from "../view-models.js";

export function prepareHomeVM(
  aggregates: AggregateIR[],
  workflows: WorkflowIR[],
  views: ViewIR[],
  systemName: string,
): HomeVM {
  const first = aggregates[0];
  return {
    systemNameHuman: humanize(systemName),
    aggregateCount: aggregates.length,
    workflowCount: workflows.length,
    viewCount: views.length,
    firstAggregateSlug: first ? snake(plural(first.name)) : undefined,
  };
}
