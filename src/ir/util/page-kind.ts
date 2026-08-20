import { plural, snake, upperFirst } from "../../util/naming.js";
import type { PageIR } from "../types/loom-ir.js";

/** The classification of a page by what the scaffold synthesised it as — an
 *  aggregate's list/new/detail, a workflow's form/instance pages, the
 *  singleton index pages, or a hand-written `custom` page.
 *
 *  This used to be *stamped* onto `PageIR.origin` at lower time (by
 *  `inferPageOrigin` + `resourceScaffoldOrigins`).  Slice 3c removed that
 *  denormalised field: a page's kind is now *derived on demand* from its
 *  role-scoped `name` + `area` (the single source of truth set by the scaffold
 *  macro / the `area` block) via `classifyPage`.  `contextName` is intentionally
 *  empty — every consumer that needs the bounded context resolves it by
 *  searching, so the name was never load-bearing. */
export type PageKind =
  | { kind: "aggregate-list"; aggregateName: string; contextName: string }
  | { kind: "aggregate-new"; aggregateName: string; contextName: string }
  | { kind: "aggregate-detail"; aggregateName: string; contextName: string }
  | { kind: "workflow-form"; workflowName: string; contextName: string }
  | { kind: "workflow-instances-list"; workflowName: string; contextName: string }
  | { kind: "workflow-instance-detail"; workflowName: string; contextName: string }
  | { kind: "workflows-index" }
  | { kind: "home" }
  | { kind: "custom" };

/** The declaration names a page is classified against — the aggregates and
 *  workflows served by the page's ui.  Every consumer already has these (the
 *  generators iterate them; lowering carries the expand context), so threading
 *  this tiny shape is cheaper than re-stamping `origin`. */
export interface PageNameCtx {
  // Arrays, not bare `Iterable` — `classifyPage` runs once per page over the
  // same ctx, so a single-use `Map.keys()` iterator would be exhausted after
  // the first page and silently misclassify the rest.
  aggregateNames: readonly string[];
  workflowNames: readonly string[];
}

/** Derive a page's {@link PageKind} from its role-scoped `name` + `area`.
 *  Reproduces exactly what `inferPageOrigin` + `classifyScaffoldPageByName`
 *  stamped before slice 3c, so generated output is byte-identical. */
export function classifyPage(page: Pick<PageIR, "name" | "area">, ctx: PageNameCtx): PageKind {
  const name = page.name;
  const area = page.area ?? [];

  // Singleton dashboard pages, identified by their reserved names.  The scaffold
  // mints exactly these names (`Home` / `WorkflowsIndex`); a hand-written page
  // sharing one is treated as that dashboard too, consistent with the
  // scaffold's override-by-name contract (write `page Home { … }` to replace
  // the generated landing page).
  if (name === "Home") return { kind: "home" };
  if (name === "WorkflowsIndex") return { kind: "workflows-index" };

  // Aggregate pages are role-named (`List`/`New`/`Detail`) inside their
  // per-aggregate `area <Plural>` block — the area's last segment identifies
  // the aggregate, the role the page kind.  Gating on the area keeps a
  // hand-written top-level `page List` on its `custom` kind.
  const last = area[area.length - 1];
  if (last !== undefined) {
    for (const aggName of ctx.aggregateNames) {
      if (last !== snake(plural(aggName))) continue;
      if (name === "List")
        return { kind: "aggregate-list", aggregateName: aggName, contextName: "" };
      if (name === "New") return { kind: "aggregate-new", aggregateName: aggName, contextName: "" };
      if (name === "Detail")
        return { kind: "aggregate-detail", aggregateName: aggName, contextName: "" };
    }
  }

  // Workflow pages keep their full declared names.
  for (const wfName of ctx.workflowNames) {
    const p = upperFirst(wfName);
    if (name === `${p}Workflow`)
      return { kind: "workflow-form", workflowName: wfName, contextName: "" };
    if (name === `${p}InstancesList`)
      return { kind: "workflow-instances-list", workflowName: wfName, contextName: "" };
    if (name === `${p}InstanceDetail`)
      return { kind: "workflow-instance-detail", workflowName: wfName, contextName: "" };
  }

  return { kind: "custom" };
}

/** The proper, aggregate-qualified identifier a page emits as in generated
 *  *target* code — the React/Vue/Angular component name, the Phoenix LiveView
 *  module / file stem, the Playwright page-object class, the smoke-test title,
 *  the router import.
 *
 *  Scaffold aggregate pages are named by *role* in the DSL (`page List` inside
 *  `area Orders`) so the file lands at its area path (`pages/orders/list.tsx`)
 *  and the unfolded source reads cleanly.  But the role name (`List`) is not
 *  unique across aggregates and reads poorly as a component identifier, so the
 *  emitted name stays the aggregate-qualified `OrderList` form — reconstructed
 *  from the page's derived {@link PageKind}.  Matches the router imports
 *  (`<OrderList />` from `./pages/orders/list`).
 *
 *  EVERY OTHER kind is qualified by its `area` path instead.  `page.name` is
 *  unique only WITHIN one area scope (`checkPageScope`, Rule 7), so a bare
 *  name is not an identity: two `area Ops { page Dashboard }` /
 *  `area Finance { page Dashboard }` blocks both produced `Dashboard`, and
 *  every consumer that keyed a component name, module stem, DU case or
 *  page-object file on it collided — duplicate Angular imports (TS2300),
 *  duplicate Feliz `Page` union cases, one Phoenix `DashboardLive` serving two
 *  routes, one Flutter `ListPage` serving every aggregate.  Folding the area
 *  path in (`OpsDashboard`) makes the name as unique as the page's emit path,
 *  which is what the name was always standing in for.  An area-less page keeps
 *  its bare name, so the whole existing corpus is byte-identical. */
export function pageEmitName(page: PageIR, ctx: PageNameCtx): string {
  const k = classifyPage(page, ctx);
  if (k.kind === "aggregate-list") return `${upperFirst(k.aggregateName)}List`;
  if (k.kind === "aggregate-new") return `${upperFirst(k.aggregateName)}New`;
  if (k.kind === "aggregate-detail") return `${upperFirst(k.aggregateName)}Detail`;
  return areaQualifiedName(page);
}

/** `page.name` prefixed by its snake-cased `area` path in PascalCase
 *  (`["ops","billing"] + "Invoices"` → `OpsBillingInvoices`).  Area-less →
 *  the bare name, unchanged. */
export function areaQualifiedName(page: Pick<PageIR, "name" | "area">): string {
  const segs = page.area ?? [];
  if (segs.length === 0) return page.name;
  return [...segs.map(pascalSegment), page.name].join("");
}

/** `ops_admin` → `OpsAdmin`.  Area segments are stored snake-cased (they come
 *  through `snake(area.name)` in `lowerUi`), so re-Pascal-case each word. */
function pascalSegment(seg: string): string {
  return seg
    .split(/[_\-\s]+/)
    .filter((w) => w.length > 0)
    .map(upperFirst)
    .join("");
}

/** The CONVENTIONAL SLOT a classified page fills, or `undefined` for a
 *  `custom` page (which has no slot — it is mounted by its own route).
 *
 *  Two consumers, at two layers, need the same answer, so it lives here beside
 *  `classifyPage` rather than in either of them (CLAUDE.md — a shared helper
 *  belongs at the layer its consumers live at):
 *
 *    - React's App-shell preparer emits its per-aggregate / per-workflow
 *      imports from a loop over the DECLARATIONS, not over `ui.pages`, so it
 *      needs to ask "which page fills aggregate Order's list slot, and where
 *      did it actually land?" (`buildPageModuleIndex`).
 *    - the IR check `loom.ui-page-slot-collision` needs to spot TWO pages
 *      claiming one slot, which is exactly the ambiguity that made the first
 *      question unanswerable. */
export function pageSlotKey(kind: PageKind): string | undefined {
  switch (kind.kind) {
    case "aggregate-list":
      return `agg:${kind.aggregateName}:list`;
    case "aggregate-new":
      return `agg:${kind.aggregateName}:new`;
    case "aggregate-detail":
      return `agg:${kind.aggregateName}:detail`;
    case "workflow-form":
      return `wf:${kind.workflowName}:form`;
    case "workflow-instances-list":
      return `wf:${kind.workflowName}:instances`;
    case "workflow-instance-detail":
      return `wf:${kind.workflowName}:instance-detail`;
    case "workflows-index":
      return "workflows-index";
    case "home":
      return "home";
    default:
      return undefined;
  }
}

/** Dotted construct id for a page's `SourceMapRecorder.file(...)` call.
 *  `${ui.name}.${page.name}` is AMBIGUOUS: a scaffolded ui repeats role names
 *  (`List`/`New`/`Detail`) across every per-aggregate `area` scope (confirmed
 *  empirically against the M8 shared fixture — `SalesUi` scaffolded over two
 *  aggregates emits two pages both named `List`, one per `area`), the exact
 *  same ambiguity `classifyPage` resolves for page *kind* above. Folding in
 *  the full area path (outermost → innermost) disambiguates while staying
 *  human-readable; a top-level page (no `area`) falls back to the
 *  unambiguous `${ui.name}.${page.name}`. Shared by all four SPA frontends
 *  AND the Phoenix LiveView emitter so the sourcemap's construct-id
 *  convention stays uniform across every backend that emits a page. */
export function pageConstructId(uiName: string, page: Pick<PageIR, "name" | "area">): string {
  return [uiName, ...(page.area ?? []), page.name].join(".");
}
