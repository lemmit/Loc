// ---------------------------------------------------------------------------
// Render orchestrator for the template-pack rendering layer.
//
// Each page kind has a single entry point here that:
//   1. Calls the matching preparer to build the page VM.
//   2. Pre-renders every component VM (cells, fields, ...) inside
//      the page VM through the pack so the templates produce
//      already-rendered HTML strings.
//   3. Renders the page template with the enriched VM.
//
// The pre-render step is what keeps page templates flat — a list
// page emits `{{{cellHtml}}}` per column, no Handlebars partials
// or `{{> (lookup ...) ...}}` indirection.
// ---------------------------------------------------------------------------

import type { AggregateIR } from "../../../ir/loom-ir.js";
import type { LoadedPack } from "./loader.js";
import { prepareListPageVM } from "./preparers/list.js";
import type { CellVM, ListPageVM } from "./view-models.js";

/** A column slot enriched with its already-rendered cell HTML.  Page
 *  templates iterate `columns` and emit `{{{cellHtml}}}` for each. */
interface RenderedColumn {
  header: string;
  cellHtml: string;
  cell: CellVM;
}

/** Render an aggregate list page through the loaded pack.  Returns
 *  the final TSX source for `src/pages/<plural>/list.tsx`. */
export function renderListPage(
  agg: AggregateIR,
  aggregatesByName: Map<string, AggregateIR>,
  pack: LoadedPack,
): string {
  const vm = prepareListPageVM(agg, aggregatesByName);
  const columns = enrichColumns(vm, pack);
  // Final page context = base VM + the rendered columns array.
  // Templates reference `vm.aggregateName`, `vm.slug`,
  // `vm.breadcrumbs`, `columns[i].header`, `columns[i].cellHtml`.
  return pack.render("page-list", { ...vm, columns });
}

function enrichColumns(vm: ListPageVM, pack: LoadedPack): RenderedColumn[] {
  // Headers and cells are index-aligned by construction in the
  // preparer.  Walk both arrays in lockstep.
  const out: RenderedColumn[] = [];
  for (let i = 0; i < vm.cells.length; i++) {
    const cell = vm.cells[i]!;
    const header = vm.columnHeaders[i] ?? "";
    const cellHtml = pack.render(cell.template, cell);
    out.push({ header, cellHtml, cell });
  }
  return out;
}
