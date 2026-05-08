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
import { prepareViewTablePageVM } from "./preparers/view-table.js";
import { prepareViewsIndexVM } from "./preparers/views-index.js";
import { prepareWorkflowFormVM } from "./preparers/workflow-form.js";
import { prepareWorkflowsIndexVM } from "./preparers/workflow-index.js";
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

/** Render a project-shell file through the loaded pack — used for
 *  package.json, vite.config.ts, tsconfig.json, index.html,
 *  Dockerfile, .dockerignore, src/api/client.ts and
 *  src/api/config.ts.  All but `api-config` take an empty VM at
 *  Phase 1.7; `api-config` takes `{ apiBaseUrl }`.  Phase 2 may
 *  diverge per pack (shadcn → tailwind config in vite, Tailwind
 *  deps in package.json, etc.). */
export function renderShellFile(
  name: string,
  vm: unknown,
  pack: LoadedPack,
): string {
  return pack.render(name, vm);
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
 *  routes.
 *
 *  Slice 6: when the deployable's `ui:` block declares an explicit
 *  `menu { … }`, the caller passes the derived `navSections` as
 *  `sidebarOverride` and we use it verbatim; otherwise the legacy
 *  hardcoded grouping (Aggregates / Workflows / Views) runs and the
 *  output is byte-identical to main's pre-Slice-6 emission. */
export function renderAppShell(
  aggregates: AggregateIR[],
  workflows: WorkflowIR[],
  views: ViewIR[],
  systemName: string,
  pack: LoadedPack,
  sidebarOverride?: import("./view-models.js").NavSectionVM[],
): string {
  const vm = prepareAppShellVM(
    aggregates,
    workflows,
    views,
    systemName,
    sidebarOverride,
  );
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

/** Render a per-workflow form page through the loaded pack. */
export function renderWorkflowForm(
  wf: WorkflowIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
  pack: LoadedPack,
): string {
  const vm = prepareWorkflowFormVM(wf, ctx, aggregatesByName);
  const fieldHtmls = vm.fields.map((f) => renderFormField(f, pack));
  return pack.render("workflow-form", { ...vm, fieldHtmls });
}

/** Render the workflows index page through the loaded pack. */
export function renderWorkflowsIndex(
  contexts: BoundedContextIR[],
  pack: LoadedPack,
): string {
  const vm = prepareWorkflowsIndexVM(contexts);
  return pack.render("workflow-index", vm);
}

/** Render the views index page through the loaded pack. */
export function renderViewsIndex(
  contexts: BoundedContextIR[],
  pack: LoadedPack,
): string {
  const vm = prepareViewsIndexVM(contexts);
  return pack.render("views-index", vm);
}

/** Render a per-view table page through the loaded pack.  Cells
 *  reuse the page-list cell-* templates by binding their VMs to
 *  view-scoped testid + access expressions (`row.<col>` and
 *  `view-<slug>-row-${idx}-<col>`). */
export function renderViewTablePage(
  view: ViewIR,
  ctx: BoundedContextIR,
  aggregatesByName: Map<string, AggregateIR>,
  pack: LoadedPack,
): string {
  const vm = prepareViewTablePageVM(view, ctx, aggregatesByName);
  const cells = vm.cells.map((cell) => ({
    ...cell,
    cellHtml: pack.render(cell.template, cell),
  }));
  return pack.render("view-table", { ...vm, cells });
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
