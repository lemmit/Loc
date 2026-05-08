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

import type {
  AggregateIR,
  BoundedContextIR,
  OperationIR,
  ThemeIR,
  ViewIR,
  WorkflowIR,
} from "../../../ir/loom-ir.js";
import type { LoadedPack } from "./loader.js";
import { prepareAppShellVM } from "./preparers/app-shell.js";
import { prepareDetailPageVM } from "./preparers/detail.js";
import { prepareFormFieldVM } from "./preparers/form-fields.js";
import { prepareHomeVM } from "./preparers/home.js";
import { prepareListPageVM } from "./preparers/list.js";
import { prepareNewPageVM } from "./preparers/new.js";
import { prepareOperationModalVM } from "./preparers/operation-modal.js";
import { prepareThemeVM } from "./preparers/theme.js";
import type {
  CellVM,
  FormFieldVM,
  ListPageVM,
  PartTableVM,
} from "./view-models.js";

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

/** Render the theme.ts file through the loaded pack.  Returns the
 *  TS source (Mantine: createTheme config; shadcn: provisionally the
 *  same Mantine-shape file until Phase 2 brings the full shell). */
export function renderTheme(t: ThemeIR | undefined, pack: LoadedPack): string {
  const vm = prepareThemeVM(t);
  return pack.render("theme", vm);
}

/** Render the App.tsx shell through the loaded pack — sidebar
 *  navigation, header bar, error boundary, and the React Router
 *  routes. */
export function renderAppShell(
  aggregates: AggregateIR[],
  workflows: WorkflowIR[],
  views: ViewIR[],
  systemName: string,
  pack: LoadedPack,
): string {
  const vm = prepareAppShellVM(aggregates, workflows, views, systemName);
  return pack.render("app-shell", vm);
}

/** Render main.tsx — the React entry point with provider chain. */
export function renderMain(pack: LoadedPack): string {
  return pack.render("main", {});
}

/** Render the home (landing) page — SimpleGrid of summary cards. */
export function renderHome(
  aggregates: AggregateIR[],
  workflows: WorkflowIR[],
  views: ViewIR[],
  systemName: string,
  pack: LoadedPack,
): string {
  const vm = prepareHomeVM(aggregates, workflows, views, systemName);
  return pack.render("home", vm);
}

/** Render the aggregate detail page through the loaded pack.
 *  Field rows, part-table cells, operation buttons, and the
 *  per-operation modal forms all pre-render in TS so the page
 *  template stays flat (no partial-pyramids). */
export function renderDetailPage(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
  pack: LoadedPack,
): string {
  const vm = prepareDetailPageVM(agg, ctx, aggregatesByName);
  const fieldRows = vm.fieldRows.map((row) => ({
    ...row,
    rowHtml: pack.render(row.template, row),
  }));
  const parts = vm.parts.map((part) => ({
    ...part,
    partHtml: renderPartTable(part, pack),
  }));
  const opButtons = vm.opButtons.map((btn) => ({
    ...btn,
    buttonHtml: pack.render("op-button", btn),
  }));
  // Operation modals — render each public operation's modal-form
  // pair through the pack and join into the operationsModalsTsx
  // slot the page template emits at module scope.
  const publicOps = agg.operations.filter((o) => o.visibility === "public");
  const operationsModalsTsx = publicOps.map((op) =>
    renderOperationModal(agg, op, ctx, aggregatesByName, pack),
  );
  return pack.render("page-detail", {
    ...vm,
    fieldRows,
    parts,
    opButtons,
    operationsModalsTsx,
  });
}

function renderPartTable(part: PartTableVM, pack: LoadedPack): string {
  const cells = part.cells.map((cell) => ({
    ...cell,
    cellHtml: pack.render(cell.template, cell),
  }));
  return pack.render("part-table", { ...part, cells });
}

/** Render a single form field through the loaded pack.  Recursive
 *  for value-object Fieldsets — children are pre-rendered via the
 *  same path and joined into `innerHtml` before the parent template
 *  fires.  Mirrors the legacy formInput's structural recursion. */
export function renderFormField(vm: FormFieldVM, pack: LoadedPack): string {
  if (vm.children && vm.children.length > 0) {
    const innerHtml = vm.children
      .map((child) => renderFormField(child, pack))
      .join("\n          ");
    return pack.render(vm.template, { ...vm, innerHtml });
  }
  return pack.render(vm.template, vm);
}

/** Render the aggregate `new` (create) page through the loaded pack. */
export function renderNewPage(
  agg: AggregateIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
  pack: LoadedPack,
): string {
  const vm = prepareNewPageVM(agg, ctx, aggregatesByName);
  const fieldHtmls = vm.fields.map((f) => renderFormField(f, pack));
  return pack.render("page-new", { ...vm, fieldHtmls });
}

/** Render an operation's modal-form pair — used by the detail-page
 *  renderer to populate the `operationsModalsTsx` slot. */
export function renderOperationModal(
  agg: AggregateIR,
  op: OperationIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
  pack: LoadedPack,
): string {
  const vm = prepareOperationModalVM(agg, op, ctx, aggregatesByName);
  const fieldHtmls = vm.fields.map((f) => renderFormField(f, pack));
  return pack.render("operation-modal", { ...vm, fieldHtmls });
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
