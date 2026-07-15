// Shared page-generation helpers for the scaffold macro family.
//
// Each `scaffold<X>` macro (scaffoldAggregate / scaffoldWorkflow /
// scaffoldView / scaffold) reaches into these to emit canonical page
// shapes.  Keeping them in one place means the per-archetype leaf
// macros and the top-level composer share one source of truth.

import type { Aggregate, Area, Page, Ui, View, Workflow } from "../../api/index.js";
import { area, boolLit, callExpr, page, stringLit } from "../../api/index.js";
import {
  filterFindsForAggregate,
  filterStateFields,
  scaffoldDetailsParts,
  scaffoldHome,
  scaffoldInstanceDetails,
  scaffoldInstanceList,
  scaffoldList,
  scaffoldNewForm,
  scaffoldOperations,
  scaffoldViewList,
  scaffoldViewsIndex,
  scaffoldWorkflowForm,
  scaffoldWorkflowsIndex,
  scalarColumnsForAggregate,
} from "./_body-builders.js";

/** The ui's first api handle (`api <name>: <Api>`), or `undefined` when the ui
 *  serves no api — the receiver root the scaffolded aggregate queries reach
 *  through (`<handle>.<Agg>.all`).  Macro-time twin of the expander's
 *  `findApiHandleFor` (first-api-param-wins). */
function firstApiHandle(ui: Ui): string | undefined {
  for (const m of ui.members) {
    if (m.$type === "UiApiParam") return m.name;
  }
  return undefined;
}

/** Group an aggregate's List/New/Detail pages under a per-aggregate `area`
 *  named after its plural (`area Orders { … }` → `src/pages/orders/…`).  The
 *  scaffold returns this instead of loose pages so the generated page tree
 *  groups by aggregate.  The pages are named by *role* (`List`/`New`/`Detail`),
 *  scoped to the area, and the `area` is authoritative for `emitPath`
 *  (`src/pages/orders/list.tsx`) — origin no longer drives it (slice 3a).  The
 *  emitted component / module identifiers stay the aggregate-qualified
 *  `OrderList` form via `pageEmitName` (output byte-identical).  See
 *  docs/old/proposals/unfoldable-page-scaffolding.md. */
export function areaForAggregate(agg: Aggregate, ui: Ui): Area {
  return area(plural(agg.name), pagesForAggregate(agg, ui));
}

/** Whether the aggregate's implicit `all` is the paged `Paged<T>` findAll
 *  (M-T2.6) rather than a bare `T[]`.  Macro-time mirror of the enrichment
 *  exclusion in `ensureFindAll` (src/ir/enrich/enrichments.ts): only a plain
 *  single-table relational aggregate pages; event-sourced, `shape(document)` /
 *  `shape(embedded)`, and inheritance-subtype (`extends`) aggregates keep the
 *  unbounded `T[]` (their read path can't be a plain SQL `LIMIT/OFFSET` page),
 *  so their scaffold list stays CLIENT-paged. */
function aggregateHasPagedFindAll(agg: Aggregate): boolean {
  return (
    agg.persistedAs !== "eventLog" && (agg.shape ?? "relational") === "relational" && !agg.superType
  );
}

export function pagesForAggregate(agg: Aggregate, ui: Ui): Page[] {
  const pluralSnake = snake(plural(agg.name));
  const aggName = agg.name;
  const labelPlural = humanize(plural(aggName));
  const apiHandle = firstApiHandle(ui);
  const filters = filterFindsForAggregate(agg);
  return [
    page({
      name: "List",
      route: `/${pluralSnake}`,
      // The full Breadcrumbs/Toolbar/QueryView/Table tree, emitted directly as
      // unfoldable source (no IR-phase sentinel expansion).  The find-filter
      // inputs bind to page state named by `filterStateFields`.
      body: scaffoldList(aggName, scalarColumnsForAggregate(agg), {
        apiHandle,
        filters,
        paged: aggregateHasPagedFindAll(agg),
      }),
      // Filter-bar state + the interactive-table sort/page state (M-T1.1):
      // `sortKey`/`sortDir` (string-init "", unsorted) drive column sort;
      // `pageNum` (1-based int) drives the client-side pager.  Consumed on the
      // JSX frontends; Feliz/HEEx ignore the Table's sort/page args (plain
      // table).  Named `pageNum`, not `page`, because `page` is a reserved
      // grammar keyword (`page X { … }`) — a `page` state field would break the
      // `unfold`-to-source round-trip.
      state: [
        ...filterStateFields(filters).map((f) => f.name),
        "sortKey",
        "sortDir",
        { name: "pageNum", type: "int", init: 1 } as const,
      ],
      menu: {
        section: stringLit("Aggregates"),
        label: stringLit(labelPlural),
      },
    }),
    page({
      name: "New",
      route: `/${pluralSnake}/new`,
      body: scaffoldNewForm(aggName),
      menu: { hidden: boolLit(true) },
    }),
    page({
      name: "Detail",
      route: `/${pluralSnake}/:id`,
      // `Stack { Breadcrumbs, Heading, QueryView, <operations> }` — the read
      // view's parts flattened directly into the page Stack (spliced, not
      // nested), then the auto-fanned
      // per-operation modals.  The outer Stack testid (`<plural>-detail`)
      // anchors the e2e page-objects.
      body: callExpr("Stack", [
        ...scaffoldDetailsParts(agg, { apiHandle }),
        { value: scaffoldOperations(agg) },
        { name: "testid", value: stringLit(`${pluralSnake}-detail`) },
      ]),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

/** An event-triggered-only workflow (every `create` carries a `by`
 *  correlation clause — a reactor / saga started by an event, never an
 *  inbound call) has no command surface: the backends emit no `run/2` /
 *  HTTP route for it (see `workflowEmitsCommandRoute`), so the scaffold
 *  must not synthesise a form page (it would `phx-submit` / POST to a
 *  route that doesn't exist).  AST mirror of the lowered predicate: the
 *  facade create is the unnamed command create, else the first create;
 *  event-triggered iff that facade has a `by` clause. */
export function workflowIsEventTriggeredOnly(wf: Workflow): boolean {
  const creates = wf.members.filter(
    (m): m is Extract<Workflow["members"][number], { $type: "WorkflowCreateDecl" }> =>
      m.$type === "WorkflowCreateDecl",
  );
  if (creates.length === 0) return false;
  const facade = creates.find((c) => !c.name && !c.correlation) ?? creates[0]!;
  return !!facade.correlation;
}

/** Whether a workflow exposes an observable instance read model
 *  (workflow-instance-visibility.md).  AST mirror of the IR rule
 *  (`lower-workflow.ts` / `enrichWorkflowInstanceShape`): a single id-shaped
 *  `Property` state field is the correlation field that keys the instance read
 *  surface.  This holds for BOTH state-table sagas (list a `<Wf>State` row) and
 *  event-sourced workflows (group-fold the `<wf>_events` stream per
 *  correlation) — both now carry `instanceWireShape` and expose
 *  `GET /workflows/<wf>/instances[/{id}]`.  Two id fields (ambiguous) or zero
 *  (no correlation) ⇒ no instance surface, matching the IR's
 *  `instanceWireShape` gate, so the scaffolded pages never reference hooks
 *  that weren't emitted. */
export function workflowIsObservable(wf: Workflow): boolean {
  const props = wf.members.filter(
    (m): m is Extract<Workflow["members"][number], { $type: "Property" }> => m.$type === "Property",
  );
  const idProps = props.filter((p) => p.type.base.$type === "IdType" && !p.type.array);
  return idProps.length === 1;
}

/** The two read-only instance pages for an observable workflow: a list of
 *  running instances and a per-instance detail (no `New` analogue — instances
 *  are born from triggers, not a form).  Mirrors `pagesForAggregate`'s
 *  List/Detail; the bodies are built by `scaffoldInstanceList` /
 *  `scaffoldInstanceDetails` in `_body-builders.ts`. */
export function pagesForWorkflowInstances(wf: Workflow): Page[] {
  const slug = snake(wf.name);
  const wfName = wf.name;
  return [
    page({
      name: `${pascal(wfName)}InstancesList`,
      route: `/workflows/${slug}/instances`,
      body: scaffoldInstanceList(wf),
      menu: {
        section: stringLit("Workflows"),
        label: stringLit(`${humanize(wfName)} Instances`),
      },
    }),
    page({
      name: `${pascal(wfName)}InstanceDetail`,
      route: `/workflows/${slug}/instances/:id`,
      body: scaffoldInstanceDetails(wf),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

export function pageForWorkflow(wf: Workflow): Page {
  return page({
    name: `${pascal(wf.name)}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    body: scaffoldWorkflowForm(wf.name),
    menu: {
      section: stringLit("Workflows"),
      label: stringLit(humanize(wf.name)),
    },
  });
}

export function pageForView(v: View): Page {
  return page({
    name: `${v.name}View`,
    route: `/views/${snake(v.name)}`,
    body: scaffoldViewList(v),
    menu: {
      section: stringLit("Views"),
      label: stringLit(humanize(v.name)),
    },
  });
}

export function homePage(counts: { aggregates: number; workflows: number; views: number }): Page {
  return page({
    name: "Home",
    route: "/",
    body: scaffoldHome(counts),
    menu: { hidden: boolLit(true) },
  });
}

export function workflowsIndexPage(workflows: readonly Workflow[]): Page {
  return page({
    name: "WorkflowsIndex",
    route: "/workflows",
    body: scaffoldWorkflowsIndex(workflows),
    menu: {
      section: stringLit("Workflows"),
      label: stringLit("Index"),
    },
  });
}

export function viewsIndexPage(views: readonly View[]): Page {
  return page({
    name: "ViewsIndex",
    route: "/views",
    body: scaffoldViewsIndex(views),
    menu: {
      section: stringLit("Views"),
      label: stringLit("Index"),
    },
  });
}

// Naming utilities — kept module-local so the helpers don't pull in
// the wider `util/naming` dep graph.

function snake(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

function plural(s: string): string {
  if (s.endsWith("y")) return s.slice(0, -1) + "ies";
  if (s.endsWith("s")) return s + "es";
  return s + "s";
}

function pascal(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function humanize(s: string): string {
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
