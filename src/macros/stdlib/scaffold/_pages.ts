// Shared page-generation helpers for the scaffold macro family.
//
// Each `scaffold<X>` macro (scaffoldAggregate / scaffoldWorkflow /
// scaffold) reaches into these to emit canonical page
// shapes.  Keeping them in one place means the per-archetype leaf
// macros and the top-level composer share one source of truth.

import { plural, snake, upperFirst } from "../../../util/naming.js";
import type { Aggregate, Area, Expression, Page, Ui, Workflow } from "../../api/index.js";
import { area, boolLit, callExpr, cloneExpr, page, stringLit } from "../../api/index.js";
import {
  filterFindsForAggregate,
  filterStateFields,
  listReadGateForAggregate,
  scaffoldDetailsParts,
  scaffoldHome,
  scaffoldInstanceDetails,
  scaffoldInstanceList,
  scaffoldList,
  scaffoldNewForm,
  scaffoldWorkflowForm,
  scaffoldWorkflowsIndex,
  scalarColumnsForAggregate,
} from "./_body-builders.js";
import { dashboardFieldsFor, summableFields } from "./_dashboard-shared.js";

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
 *  (`src/pages/orders/list.tsx`).  The emitted component / module identifiers
 *  are the aggregate-qualified `OrderList` form via `pageEmitName`.  See
 *  docs/old/proposals/unfoldable-page-scaffolding.md. */
export function areaForAggregate(agg: Aggregate, ui: Ui): Area {
  return area(plural(agg.name), pagesForAggregate(agg, ui));
}

/** Whether the aggregate's `all` read is the paged `Paged<T>` findAll (M-T2.6)
 *  rather than a bare `T[]` — the fact the whole scaffolded list body hangs
 *  off: a server-paged list calls `all(pageNum, 10, sortKey, sortDir)` and
 *  unwraps `.items`, a client-paged one calls a bare `all` over an array.
 *
 *  Two cases, and the ORDER matters:
 *
 *  1. The author DECLARED `find all` on the aggregate's repository.  Then the
 *     enrichment's `ensureFindAll` leaves it alone and the shape is whatever
 *     was written, so the only honest answer is that find's own return type —
 *     read here exactly the way the backends read it (`pagedReturn`, i.e. the
 *     outermost `paged` carrier).  Guessing instead is what emitted a
 *     `list_<agg>s(page, size, sort, dir)` call against the bare 0-arity
 *     `defdelegate list_<agg>s()` the declared `T[]` find produces — a project
 *     that fails `mix compile` (M-T6.40), with the same shape on the JSX
 *     frontends (`useAllOrders()` called with four arguments).
 *  2. No declared `all` — the read is the SYNTHESISED findAll, so mirror
 *     `ensureFindAll`'s own exclusions (src/ir/enrich/enrichments.ts): only a
 *     plain single-table relational aggregate pages; event-sourced,
 *     `shape: document` / `shape: embedded`, and inheritance-subtype
 *     (`extends`) aggregates keep the unbounded `T[]` (their read path can't be
 *     a plain SQL `LIMIT/OFFSET` page), so their scaffold list stays
 *     CLIENT-paged. */
function aggregateHasPagedFindAll(agg: Aggregate): boolean {
  const declaredAll = declaredFindAll(agg);
  if (declaredAll) return declaredAll.returnType.ctors?.includes("paged") ?? false;
  return (
    agg.persistedAs !== "eventLog" && (agg.shape ?? "relational") === "relational" && !agg.superType
  );
}

/** The aggregate's AUTHOR-DECLARED `find all`, if its context declares a
 *  repository for it that spells one out.  Macro-time twin of the context
 *  emitters' `(ctx.repositories ?? []).find(r => r.aggregateName === agg.name)
 *  ?.finds?.find(f => f.name === "all")`, so the scaffolded call site and the
 *  emitted delegate read the SAME declaration. */
function declaredFindAll(agg: Aggregate): { returnType: { ctors?: string[] } } | undefined {
  for (const m of agg.$container.members) {
    if (m.$type !== "Repository") continue;
    if (m.aggregate.ref?.name !== agg.name && m.aggregate.$refText !== agg.name) continue;
    const all = m.finds.find((f) => f.name === "all");
    if (all) return all;
  }
  return undefined;
}

export function pagesForAggregate(agg: Aggregate, ui: Ui): Page[] {
  const pluralSnake = snake(plural(agg.name));
  const aggName = agg.name;
  const labelPlural = humanize(plural(aggName));
  const apiHandle = firstApiHandle(ui);
  const filters = filterFindsForAggregate(agg);
  // The `find all(): T[] requires …` gate guards `GET /<aggs>` — the very read
  // this List page makes.  Same reasoning as the workflow-instance pages: the
  // nav link's visibility is rendered from the PAGE's gate, so without this the
  // entry shows for a principal the backend refuses.  A find gate is
  // `currentUser`-only by validation (`loom.find-gate-not-current-user`), so it
  // ports to the client unchanged.
  const listGate = listReadGateForAggregate(agg);
  return [
    page({
      name: "List",
      route: `/${pluralSnake}`,
      requires: listGate ? cloneExpr(listGate) : undefined,
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
      // table).  Named `pageNum` for readability beside `pageSize`, not out of
      // necessity: `page` is a soft keyword in every identifier position now
      // (M-T1.3 Defect B), so a `page` state field parses and round-trips
      // through `unfold`.  Left as `pageNum` because renaming it is emitted-
      // output churn across six frontends for no behavioural gain.
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
      // `Stack { Breadcrumbs, Heading, QueryView }` — the read view's parts
      // flattened directly into the page Stack (spliced, not nested).  The
      // per-operation modals are auto-fanned INSIDE the QueryView's `data`
      // lambda (`withOperations`), so each op form is instance-qualified against
      // the loaded record and a `this.<field>` param default seeds from it.  The
      // outer Stack testid (`<plural>-detail`) anchors the e2e page-objects.
      body: callExpr("Stack", [
        ...scaffoldDetailsParts(agg, { apiHandle, withOperations: true }),
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
  // Match the IR's `instanceWireShape` gate, which counts state fields whose
  // lowered type kind is exactly `id`.  An optional `X id?` lowers to
  // `{kind:"optional", inner:{kind:"id"}}` (kind `optional`, not `id`), so it
  // is NOT a correlation field there — exclude it here too, or the scaffold
  // emits instance pages hitting an endpoint the IR never generated.
  const idProps = props.filter(
    (p) => p.type.base.$type === "IdType" && !p.type.array && !p.type.optional,
  );
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
  // The workflow's HEADER gate guards `GET /workflows/<wf>/instances[/{id}]`
  // (M-T3.15 §A2) — the exact two routes these pages read.  Propagate it, or
  // the scaffold emits a visible nav entry that 403s on click: `menu-emitter`
  // renders a link's visibility from the PAGE's own `requires`, and knows
  // nothing about the route's.  Cloned per page — an AST node has one
  // `$container`, so sharing would move the gate off the workflow.
  //
  // Sound because a workflow header gate is `currentUser`-only by validation
  // (`loom.workflow-gate-not-current-user`), which is precisely the subset a
  // page gate can evaluate client-side.
  const gate = (): Expression | undefined => (wf.gate ? cloneExpr(wf.gate) : undefined);
  return [
    page({
      name: `${upperFirst(wfName)}InstancesList`,
      route: `/workflows/${slug}/instances`,
      requires: gate(),
      body: scaffoldInstanceList(wf),
      menu: {
        section: stringLit("Workflows"),
        label: stringLit(`${humanize(wfName)} Instances`),
      },
    }),
    page({
      name: `${upperFirst(wfName)}InstanceDetail`,
      route: `/workflows/${slug}/instances/:id`,
      requires: gate(),
      body: scaffoldInstanceDetails(wf),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

export function pageForWorkflow(wf: Workflow): Page {
  return page({
    name: `${upperFirst(wf.name)}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    body: scaffoldWorkflowForm(wf.name),
    menu: {
      section: stringLit("Workflows"),
      label: stringLit(humanize(wf.name)),
    },
  });
}

export function homePage(
  counts: { aggregates: number; workflows: number },
  /** Aggregates whose context carries a dashboard projection.  Each becomes a
   *  row of KPI tiles above the summary cards; an empty list leaves the welcome
   *  page byte-identical. */
  aggregates: readonly Aggregate[] = [],
  ui?: Ui,
): Page {
  const apiHandle = ui ? firstApiHandle(ui) : undefined;
  const kpis = aggregates.flatMap((agg) => {
    const found = dashboardFieldsFor(agg);
    if (!found) return [];
    // A `<field>Sum` tile is money iff the SOURCE field is — the projection row
    // carries no type the walker can read, so the aggregate decides.
    const moneyFields = summableFields(agg)
      .filter((f) => f.primitive === "money")
      .map((f) => `${f.name}Sum`);
    return [{ aggregate: agg.name, apiHandle, ...found, moneyFields }];
  });
  return page({
    name: "Home",
    route: "/",
    body: scaffoldHome(counts, kpis),
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

// Naming utilities — `plural`/`snake`/`upperFirst` come from `util/naming` (the
// single source of truth `classifyPage` also consumes, so scaffolded `area`
// names match the classifier for irregular plurals).  `humanize` stays
// module-local (display labels only).

function humanize(s: string): string {
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
