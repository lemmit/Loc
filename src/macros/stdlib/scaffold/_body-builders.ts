// Macro-layer (AST→AST) scaffolders for page bodies.
//
// Each scaffolder builds a page body as Langium AST, so its output prints to
// literal `.ddd` source and unfolds like any other macro.  `scaffoldList`
// scaffolds a list; `scaffoldNewForm` scaffolds a new-form — the name is the
// spec.  See `docs/old/proposals/unfoldable-page-scaffolding.md`.
//
// Status: this is the ONLY scaffold body path.  The scaffold macro family
// (`_pages.ts`) returns these full AST trees directly as page bodies — `unfold`
// on a scaffolded page reveals real `.ddd` source.  The full family is in place:
// `scaffoldList` (per-type columns + `rowTestid` + the find-filter bar),
// `scaffoldNewForm`, `scaffoldDetails` (value-object sub-rows + related-entity
// cards), `scaffoldOperations`, `scaffoldWorkflowForm`, `scaffoldViewList`, the
// workflow-instance list/detail, and the `scaffoldHome` / `scaffoldWorkflowsIndex`
// / `scaffoldViewsIndex` dashboards.  (The old IR-phase ⑤c expanders these once
// mirrored are deleted — there is no sentinel layer left.)

import type {
  Aggregate,
  Containment,
  EntityPart,
  Expression,
  Operation,
  Property,
  TypeRef,
  ValueObject,
  View,
  Workflow,
} from "../../../language/generated/ast.js";
import {
  binaryExpr,
  boolLit,
  callExpr,
  intLit,
  lambda,
  matchExpr,
  memberAccess,
  nameRefExpr,
  stringLit,
  ternaryExpr,
} from "../../api/index.js";

/** `scaffoldNewForm` — scaffolds the create page body:
 *  `Stack(Breadcrumbs, Heading "Create <agg>", Card(CreateForm(of:)))`. */
export function scaffoldNewForm(aggName: string): Expression {
  const slug = snake(plural(aggName));
  const humanPlural = humanize(plural(aggName));
  const humanAgg = humanize(aggName);
  return callExpr("Stack", [
    { value: breadcrumbs(humanPlural, slug, "New") },
    {
      value: callExpr("Heading", [
        { value: stringLit(`Create ${humanAgg.toLowerCase()}`) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("Card", [
        {
          value: callExpr("CreateForm", [
            { name: "of", value: nameRefExpr(aggName) },
            { name: "testid", value: stringLit(`${slug}-new`) },
          ]),
        },
      ]),
    },
    { name: "testid", value: stringLit(`${slug}-new-page`) },
  ]);
}

/** `scaffoldOperations` — scaffolds the Detail page's operation surface:
 *  `Group(Modal × N)`, one Modal per public operation, each holding an
 *  `OperationForm(of: <Agg>, op: <opName>)` and triggered by a button (the
 *  first operation's button is primary, the rest secondary).  No public
 *  operations ⇒ an empty `Group()`.
 *  public = the aggregate's non-`private` operations. */
export function scaffoldOperations(agg: Aggregate): Expression {
  const slug = snake(plural(agg.name));
  const publicOps = agg.members.filter(
    (m): m is Operation => m.$type === "Operation" && !m.private,
  );
  if (publicOps.length === 0) return callExpr("Group", []);
  return callExpr(
    "Group",
    publicOps.map((op, i) => ({
      value: callExpr("Modal", [
        {
          value: callExpr("OperationForm", [
            { name: "of", value: nameRefExpr(agg.name) },
            { name: "op", value: nameRefExpr(op.name) },
            { name: "testid", value: stringLit(`${slug}-op-${op.name}`) },
          ]),
        },
        { name: "title", value: stringLit(humanize(op.name)) },
        {
          name: "trigger",
          value: callExpr("Button", [
            { value: stringLit(humanize(op.name)) },
            { name: "emphasis", value: stringLit(i === 0 ? "primary" : "secondary") },
            { name: "testid", value: stringLit(`${slug}-op-${op.name}`) },
          ]),
        },
      ]),
    })),
  );
}

/** `scaffoldWorkflowForm` — scaffolds a workflow's command page body:
 *  `Stack(Breadcrumbs, Heading, Card(WorkflowForm(runs: <Wf>)))`. */
export function scaffoldWorkflowForm(wfName: string): Expression {
  const wfSlug = snake(wfName);
  const humanWf = humanize(wfName);
  return callExpr("Stack", [
    {
      value: callExpr("Breadcrumbs", [
        {
          value: callExpr("Anchor", [
            { value: stringLit("Home") },
            { name: "to", value: stringLit("/") },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit("Workflows") },
            { name: "to", value: stringLit("/workflows") },
          ]),
        },
        { value: callExpr("Text", [{ value: stringLit(humanWf) }]) },
      ]),
    },
    {
      value: callExpr("Heading", [
        { value: stringLit(humanWf) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("Card", [
        {
          value: callExpr("WorkflowForm", [
            { name: "runs", value: nameRefExpr(wfName) },
            { name: "testid", value: stringLit(`workflow-${wfSlug}`) },
          ]),
        },
      ]),
    },
    { name: "testid", value: stringLit(`workflow-${wfSlug}-page`) },
  ]);
}

/** `scaffoldViewList` — scaffolds a view's read page body:
 *  `Stack(Heading, QueryView(of: Views.<View>, …, Paper(Table)))`.  Columns come from the view's own output record
 *  when it declares one, else the source's shape — a workflow source's instance
 *  wire shape, or the source aggregate's fields. */
export function scaffoldViewList(view: View): Expression {
  const humanView = humanize(view.name);
  const cols = columnsFromProperties(viewColumnFields(view)).map((c) => ({
    value: callExpr("Column", [
      { value: stringLit(humanize(c.name)) },
      { value: lambda("o", columnAccessor(c.name, c.kind, "o")) },
    ]),
  }));
  const table = callExpr("Table", [
    ...cols,
    { name: "rows", value: nameRefExpr("rows") },
    { name: "striped", value: boolLit(true) },
    { name: "highlight", value: boolLit(true) },
    { name: "sticky", value: boolLit(true) },
    { name: "keyExpr", value: stringLit("idx") },
  ]);
  return callExpr("Stack", [
    {
      value: callExpr("Heading", [
        { value: stringLit(humanView) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("QueryView", [
        { name: "of", value: memberAccess(nameRefExpr("Views"), view.name) },
        { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(5) }]) },
        {
          name: "error",
          value: callExpr("Alert", [
            { value: stringLit(`Couldn't load ${humanView.toLowerCase()}`) },
          ]),
        },
        { name: "empty", value: callExpr("Empty", [{ value: stringLit("No rows.") }]) },
        { name: "data", value: lambda("rows", callExpr("Paper", [{ value: table }])) },
      ]),
    },
    { name: "testid", value: stringLit(`view-${snake(view.name)}`) },
  ]);
}

/** `scaffoldHome` — the welcome page body: one summary `Card` per non-empty
 *  section (aggregates / workflows / views).
 *  Counts come from the scaffold macro's gathered inventory. */
export function scaffoldHome(counts: {
  aggregates: number;
  workflows: number;
  views: number;
}): Expression {
  const cards: Array<{ value: Expression }> = [];
  if (counts.aggregates > 0) {
    cards.push({
      value: callExpr("Card", [
        {
          value: callExpr("Heading", [
            { value: stringLit(pluralizeCount(counts.aggregates, "aggregate", "aggregates")) },
            { name: "level", value: intLit(4) },
          ]),
        },
        {
          value: callExpr("Text", [
            { value: stringLit("Manage records of each kind from the sidebar.") },
          ]),
        },
      ]),
    });
  }
  if (counts.workflows > 0) {
    cards.push({
      value: callExpr("Card", [
        {
          value: callExpr("Heading", [
            { value: stringLit(pluralizeCount(counts.workflows, "workflow", "workflows")) },
            { name: "level", value: intLit(4) },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit("Open workflows →") },
            { name: "to", value: stringLit("/workflows") },
          ]),
        },
      ]),
    });
  }
  if (counts.views > 0) {
    cards.push({
      value: callExpr("Card", [
        {
          value: callExpr("Heading", [
            { value: stringLit(pluralizeCount(counts.views, "view", "views")) },
            { name: "level", value: intLit(4) },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit("Open views →") },
            { name: "to", value: stringLit("/views") },
          ]),
        },
      ]),
    });
  }
  return callExpr("Stack", [
    {
      value: callExpr("Heading", [
        { value: stringLit("Welcome") },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("Text", [
        {
          value: stringLit("Pick a section from the sidebar to start, or jump straight in below."),
        },
      ]),
    },
    { value: callExpr("Stack", cards) },
    { name: "testid", value: stringLit("home") },
  ]);
}

/** `scaffoldWorkflowsIndex` — the workflows index page body: Breadcrumbs +
 *  Heading + one `Card` per workflow. */
export function scaffoldWorkflowsIndex(workflows: readonly Workflow[]): Expression {
  const cards = workflows.map((wf) => {
    const slug = snake(wf.name);
    return {
      value: callExpr("Card", [
        {
          value: callExpr("Heading", [
            { value: stringLit(humanize(wf.name)) },
            { name: "level", value: intLit(4) },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit("Run →") },
            { name: "to", value: stringLit(`/workflows/${slug}`) },
            { name: "testid", value: stringLit(`workflow-${slug}-run`) },
          ]),
        },
        { name: "testid", value: stringLit(`workflow-card-${slug}`) },
      ]),
    };
  });
  return callExpr("Stack", [
    { value: breadcrumbs("Workflows", "workflows") },
    {
      value: callExpr("Heading", [
        { value: stringLit("Workflows") },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("Text", [
        { value: stringLit("System-level orchestrations.  Pick one to run.") },
      ]),
    },
    { value: callExpr("Stack", cards) },
    { name: "testid", value: stringLit("workflows-index") },
  ]);
}

/** `scaffoldViewsIndex` — the views index page body: Breadcrumbs + Heading +
 *  one `Card` per view. */
export function scaffoldViewsIndex(views: readonly View[]): Expression {
  const cards = views.map((view) => {
    const slug = snake(view.name);
    return {
      value: callExpr("Card", [
        {
          value: callExpr("Heading", [
            { value: stringLit(humanize(view.name)) },
            { name: "level", value: intLit(4) },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit("Open →") },
            { name: "to", value: stringLit(`/views/${slug}`) },
            { name: "testid", value: stringLit(`view-${slug}-open`) },
          ]),
        },
        { name: "testid", value: stringLit(`view-card-${slug}`) },
      ]),
    };
  });
  return callExpr("Stack", [
    { value: breadcrumbs("Views", "views") },
    {
      value: callExpr("Heading", [
        { value: stringLit("Views") },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("Text", [{ value: stringLit("Saved queries.  Open one to inspect rows.") }]),
    },
    { value: callExpr("Stack", cards) },
    { name: "testid", value: stringLit("views-index") },
  ]);
}

/** `${n} ${singular|plural}` — a pluralised count label. */
function pluralizeCount(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** `scaffoldInstanceList` — scaffolds an observable workflow's running-instances
 *  list page body.  The correlation
 *  column links to the instance detail (an `Anchor`, not an `IdLink`), the rest
 *  dispatch by type; `rowTestid` keys on the correlation field. */
export function scaffoldInstanceList(wf: Workflow): Expression {
  const slug = snake(wf.name);
  const humanWf = humanize(wf.name);
  const lowerWf = humanWf.toLowerCase();
  const corr = workflowCorrelation(wf);
  const corrName = corr ? String(corr.name) : "";
  const queryRoot = (): Expression => memberAccess(nameRefExpr(wf.name), "instances");

  const cols: Array<{ name?: string; value: Expression }> = [];
  for (const p of workflowInstanceProperties(wf)) {
    const name = String(p.name);
    if (corr && p.name === corr.name) {
      cols.push({
        value: callExpr("Column", [
          { value: stringLit(humanize(name)) },
          {
            value: lambda(
              "i",
              callExpr("Anchor", [
                { value: memberAccess(nameRefExpr("i"), name) },
                {
                  name: "to",
                  value: binaryExpr(
                    stringLit(`/workflows/${slug}/instances/`),
                    "+",
                    memberAccess(nameRefExpr("i"), name),
                  ),
                },
              ]),
            ),
          },
        ]),
      });
      continue;
    }
    const kind = columnKindForType(p.type);
    if (!kind) continue; // skip value-objects / arrays
    cols.push({
      value: callExpr("Column", [
        { value: stringLit(humanize(name)) },
        { value: lambda("i", columnAccessor(name, kind, "i")) },
      ]),
    });
  }

  const table = callExpr("Table", [
    ...cols,
    { name: "rows", value: nameRefExpr("rows") },
    { name: "striped", value: boolLit(true) },
    { name: "highlight", value: boolLit(true) },
    { name: "sticky", value: boolLit(true) },
    // ES-workflow instances carry no `id` (they're keyed by the
    // correlation field, the stream key), so the Table's default
    // `row.id` React key would not type-check.  Key on the correlation
    // field — unique per instance and already the row testid — falling
    // back to the row index if a workflow somehow lacks one.
    {
      name: "keyExpr",
      value: stringLit(corrName ? `row.${corrName}` : "idx"),
    },
    {
      name: "rowTestid",
      value: lambda(
        "r",
        binaryExpr(
          stringLit(`${slug}-instances-row-`),
          "+",
          memberAccess(nameRefExpr("r"), corrName),
        ),
      ),
    },
  ]);

  return callExpr("Stack", [
    {
      value: callExpr("Breadcrumbs", [
        {
          value: callExpr("Anchor", [
            { value: stringLit("Home") },
            { name: "to", value: stringLit("/") },
          ]),
        },
        { value: callExpr("Text", [{ value: stringLit("Workflows") }]) },
        { value: callExpr("Text", [{ value: stringLit(`${humanWf} instances`) }]) },
      ]),
    },
    {
      value: callExpr("Heading", [
        { value: stringLit(`${humanWf} instances`) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("QueryView", [
        { name: "of", value: memberAccess(queryRoot(), "all") },
        { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(5) }]) },
        {
          name: "error",
          value: callExpr("Alert", [{ value: stringLit(`Couldn't load ${lowerWf} instances`) }]),
        },
        {
          name: "empty",
          value: callExpr("Empty", [{ value: stringLit(`No ${lowerWf} instances yet.`) }]),
        },
        { name: "data", value: lambda("rows", callExpr("Paper", [{ value: table }])) },
      ]),
    },
    { name: "testid", value: stringLit(`${slug}-instances-list`) },
  ]);
}

/** `scaffoldInstanceDetails` — scaffolds a workflow instance's detail page body:
 *  a `QueryView` (by id) over a `Card` of `KeyValueRow`s, one per instance field
 *  (arrays skipped, value-objects rendered as `Text`). */
export function scaffoldInstanceDetails(wf: Workflow): Expression {
  const slug = snake(wf.name);
  const humanWf = humanize(wf.name);
  const lowerWf = humanWf.toLowerCase();
  const queryRoot = (): Expression => memberAccess(nameRefExpr(wf.name), "instances");

  const rows: Array<{ name?: string; value: Expression }> = [];
  for (const p of workflowInstanceProperties(wf)) {
    const kind = kindForType(p.type, true); // arrays skip; value-objects → Text
    if (!kind) continue;
    const name = String(p.name);
    rows.push({
      value: callExpr("KeyValueRow", [
        { value: stringLit(humanize(name)) },
        { value: typedCell(() => memberAccess(nameRefExpr("data"), name), kind) },
      ]),
    });
  }

  return callExpr("Stack", [
    {
      value: callExpr("Breadcrumbs", [
        {
          value: callExpr("Anchor", [
            { value: stringLit("Home") },
            { name: "to", value: stringLit("/") },
          ]),
        },
        { value: callExpr("Text", [{ value: stringLit("Workflows") }]) },
        {
          value: callExpr("Anchor", [
            { value: stringLit(`${humanWf} instances`) },
            { name: "to", value: stringLit(`/workflows/${slug}/instances`) },
          ]),
        },
        { value: callExpr("Text", [{ value: stringLit("Detail") }]) },
      ]),
    },
    {
      value: callExpr("Heading", [
        { value: stringLit(`${humanWf} instance`) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("QueryView", [
        {
          name: "of",
          value: memberAccess(queryRoot(), "byId", { call: true, args: [nameRefExpr("id")] }),
        },
        { name: "single", value: boolLit(true) },
        { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(3) }]) },
        {
          name: "error",
          value: callExpr("Alert", [{ value: stringLit(`Couldn't load ${lowerWf} instance`) }]),
        },
        {
          name: "empty",
          value: callExpr("Alert", [
            { value: stringLit(`No ${lowerWf} instance matches that id.`) },
            { name: "color", value: stringLit("yellow") },
          ]),
        },
        { name: "data", value: lambda("data", callExpr("Card", rows)) },
      ]),
    },
  ]);
}

/** `scaffoldDetails` — scaffolds an aggregate's read-side Detail section:
 *  `Stack(Breadcrumbs, Heading, QueryView(byId) → Card of field rows + related
 *  cards)`.  Pairs
 *  with `scaffoldOperations` on the Detail page; `apiHandle` is the ui's api
 *  param when the aggregate is served over one. */
export function scaffoldDetails(agg: Aggregate, opts: { apiHandle?: string } = {}): Expression {
  return callExpr("Stack", scaffoldDetailsParts(agg, opts));
}

/** The Detail read-section's `Stack` children — `[Breadcrumbs, Heading,
 *  QueryView]`.  Exposed separately so the Detail page can *flatten* them into
 *  its outer `Stack` alongside the operation modals (flattened into the page Stack rather than nested). */
export function scaffoldDetailsParts(
  agg: Aggregate,
  opts: { apiHandle?: string } = {},
): Array<{ name?: string; value: Expression }> {
  const slug = snake(plural(agg.name));
  const humanPlural = humanize(plural(agg.name));
  const humanAgg = humanize(agg.name);
  const lowerAgg = humanAgg.toLowerCase();
  const cellVar = "data";
  const queryRoot = (): Expression =>
    opts.apiHandle ? memberAccess(nameRefExpr(opts.apiHandle), agg.name) : nameRefExpr(agg.name);

  const { card, related } = buildDataCardParts(agg, cellVar);
  const dataBody =
    related.length === 0
      ? card
      : callExpr("Stack", [{ value: card }, ...related.map((r) => ({ value: r }))]);

  return [
    {
      value: callExpr("Breadcrumbs", [
        {
          value: callExpr("Anchor", [
            { value: stringLit("Home") },
            { name: "to", value: stringLit("/") },
          ]),
        },
        {
          value: callExpr("Anchor", [
            { value: stringLit(humanPlural) },
            { name: "to", value: stringLit(`/${slug}`) },
          ]),
        },
        { value: callExpr("Text", [{ value: stringLit("Detail") }]) },
      ]),
    },
    {
      value: callExpr("Heading", [
        { value: stringLit(`${humanAgg} detail`) },
        { name: "level", value: intLit(2) },
      ]),
    },
    {
      value: callExpr("QueryView", [
        {
          name: "of",
          value: memberAccess(queryRoot(), "byId", { call: true, args: [nameRefExpr("id")] }),
        },
        { name: "single", value: boolLit(true) },
        { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(3) }]) },
        {
          name: "error",
          value: callExpr("Alert", [{ value: stringLit(`Couldn't load ${lowerAgg}`) }]),
        },
        {
          name: "empty",
          value: callExpr("Alert", [
            { value: stringLit(`No ${lowerAgg} matches that id.`) },
            { name: "color", value: stringLit("yellow") },
          ]),
        },
        { name: "data", value: lambda(cellVar, dataBody) },
      ]),
    },
  ];
}

/** The Detail page's field card + related-entity cards.  Each scalar field is a
 *  `KeyValueRow`; value-object fields flatten into labelled leaf rows
 *  (`valueObjectRows`); each containment becomes a `Card` — a `Table` for a
 *  collection, a labelled `KeyValueRow` stack for a single part.  AST twin of
 *  `buildDataCardParts`. */
function buildDataCardParts(
  agg: Aggregate,
  cellVar: string,
): { card: Expression; related: Expression[] } {
  const slug = snake(plural(agg.name));
  const rows: Array<{ name?: string; value: Expression }> = [];
  for (const f of apiVisibleProperties(agg.members)) {
    if (f.type.array) continue;
    const name = String(f.name);
    const vo = valueObjectTarget(f.type);
    if (vo) {
      rows.push(
        ...valueObjectRows(() => memberAccess(nameRefExpr(cellVar), name), humanize(name), vo),
      );
      continue;
    }
    const kind = kindForType(f.type, true)!; // non-array, VO handled above ⇒ always a cell
    rows.push({
      value: callExpr("KeyValueRow", [
        { value: stringLit(humanize(name)) },
        { value: typedCell(() => memberAccess(nameRefExpr(cellVar), name), kind) },
        { name: "testid", value: stringLit(`${slug}-detail-${name}`) },
      ]),
    });
  }

  const related: Expression[] = [];
  for (const c of agg.members.filter((m): m is Containment => m.$type === "Containment")) {
    const part = c.partType.ref;
    if (!part) continue;
    related.push(relatedCard(c, part, cellVar, slug));
  }

  return { card: callExpr("Card", [{ value: callExpr("Stack", rows) }]), related };
}

/** One related-entity `Card` for a containment — a framed `Table` over the
 *  collection, or a labelled `KeyValueRow` stack for a single part. */
function relatedCard(c: Containment, part: EntityPart, cellVar: string, slug: string): Expression {
  const humanPart = humanize(c.name);
  const heading = callExpr("Heading", [
    { value: stringLit(humanPart) },
    { name: "level", value: intLit(4) },
  ]);
  const testid = { name: "testid", value: stringLit(`${slug}-detail-${snake(c.name)}`) };
  if (c.collection) {
    const cols = columnsFromProperties(propertiesOf(part.members)).map((col) => ({
      value: callExpr("Column", [
        { value: stringLit(humanize(col.name)) },
        { value: lambda("row", columnAccessor(col.name, col.kind, "row")) },
      ]),
    }));
    const table = callExpr("Table", [
      ...cols,
      { name: "rows", value: memberAccess(nameRefExpr(cellVar), c.name) },
      { name: "striped", value: boolLit(true) },
      { name: "highlight", value: boolLit(true) },
      { name: "keyExpr", value: stringLit("idx") },
    ]);
    return callExpr("Card", [
      { value: callExpr("Stack", [{ value: heading }, { value: table }]) },
      testid,
    ]);
  }
  // Single part: one KeyValueRow per scalar field, rooted at `<cell>.<part>.<f>`.
  const singleRows = columnsFromProperties(propertiesOf(part.members)).map((col) => ({
    value: callExpr("KeyValueRow", [
      { value: stringLit(humanize(col.name)) },
      {
        value: typedCell(
          () => memberAccess(memberAccess(nameRefExpr(cellVar), c.name), col.name),
          col.kind,
        ),
      },
    ]),
  }));
  return callExpr("Card", [
    { value: callExpr("Stack", [{ value: heading }, { value: callExpr("Stack", singleRows) }]) },
    testid,
  ]);
}

/** Flatten a value-object field into labelled leaf rows, recursing through
 *  nested value objects.  AST twin of `valueObjectRows`; the VO is resolved
 *  straight off the field's type cross-reference. */
function valueObjectRows(
  receiver: () => Expression,
  labelPrefix: string,
  vo: ValueObject,
): Array<{ name?: string; value: Expression }> {
  const out: Array<{ name?: string; value: Expression }> = [];
  for (const lf of propertiesOf(vo.members)) {
    if (lf.type.array) continue;
    const name = String(lf.name);
    const label = `${labelPrefix} ${humanize(name)}`;
    const nested = valueObjectTarget(lf.type);
    if (nested) {
      out.push(...valueObjectRows(() => memberAccess(receiver(), name), label, nested));
      continue;
    }
    const kind = kindForType(lf.type, true)!;
    out.push({
      value: callExpr("KeyValueRow", [
        { value: stringLit(label) },
        { value: typedCell(() => memberAccess(receiver(), name), kind) },
      ]),
    });
  }
  return out;
}

/** The `ValueObject` a field's type points at, or `undefined` when it isn't a
 *  value-object reference. */
function valueObjectTarget(type: TypeRef): ValueObject | undefined {
  if (type.array) return undefined;
  const base = type.base;
  if (base.$type !== "NamedType") return undefined;
  const ref = base.target.ref;
  return ref?.$type === "ValueObject" ? ref : undefined;
}

/** The property list a view's columns walk: its declared output record when
 *  present, else the source shape — a workflow source's instance wire shape or
 *  the source aggregate's fields. */
function viewColumnFields(view: View): Property[] {
  if (view.fields.length > 0) return view.fields;
  const src = view.source.ref;
  if (src?.$type === "Workflow") return workflowInstanceProperties(src);
  if (src?.$type === "Aggregate") return propertiesOf(src.members);
  return [];
}

/** A workflow's correlation field — the single id-shaped state property — or
 *  `undefined` when absent/ambiguous (no persisted instance, matching the
 *  enrichment gate). */
function workflowCorrelation(wf: Workflow): Property | undefined {
  const idProps = propertiesOf(wf.members).filter(
    (p) => p.type.base.$type === "IdType" && !p.type.array,
  );
  return idProps.length === 1 ? idProps[0] : undefined;
}

/** A workflow's persisted-instance properties in wire-shape order — the
 *  correlation field first (the `token`), then the remaining state fields in
 *  declaration order.  Twin of `wireFieldsForWorkflow`; no correlation ⇒ no
 *  instance shape (empty).  Shared by the view-list and instance builders. */
function workflowInstanceProperties(wf: Workflow): Property[] {
  const corr = workflowCorrelation(wf);
  if (!corr) return [];
  return [corr, ...propertiesOf(wf.members).filter((p) => p.name !== corr.name)];
}

/** The display dispatch a list/table column renders through — the
 *  column's type switch, resolved from the aggregate's AST at
 *  scaffold time (see `scalarColumnsForAggregate`) so the builder stays
 *  data-only. */
export type ColumnKind =
  | { tag: "id"; targetName: string }
  | { tag: "datetime" }
  | { tag: "bool" }
  | { tag: "numeric" } // decimal / money / int / long — bare text
  | { tag: "enum" }
  | { tag: "text" }; // string / guid / json / fallback

export interface ScaffoldColumn {
  name: string;
  kind: ColumnKind;
}

/** A type-dispatched cell renderer rooted at an arbitrary receiver — the
 *  type-dispatched cell: ids link, datetimes format, bools render
 *  a Yes/No ternary, enums badge, everything else is plain `Text`.  `receiver`
 *  is a thunk so each call builds fresh AST nodes. */
function typedCell(receiver: () => Expression, kind: ColumnKind): Expression {
  switch (kind.tag) {
    case "id":
      return callExpr("IdLink", [
        { value: receiver() },
        { name: "of", value: nameRefExpr(kind.targetName) },
      ]);
    case "datetime":
      return callExpr("DateDisplay", [{ value: receiver() }]);
    case "bool":
      return callExpr("Text", [
        { value: ternaryExpr(receiver(), stringLit("Yes"), stringLit("No")) },
      ]);
    case "enum":
      return callExpr("EnumBadge", [{ value: receiver() }]);
    default: // "numeric" | "text"
      return callExpr("Text", [{ value: receiver() }]);
  }
}

/** One table cell accessor `<rowVar>.<field>`, dispatched by type. */
function columnAccessor(fieldName: string, kind: ColumnKind, rowVar: string): Expression {
  return typedCell(() => memberAccess(nameRefExpr(rowVar), fieldName), kind);
}

/** Resolve an aggregate's scalar list columns from its AST — one `ScaffoldColumn`
 *  per non-array `Property`, dispatched by the field's resolved type, skipping
 *  value-object fields (no scalar cell).  It computes, at macro time from the
 *  aggregate's AST, the column kinds a list page needs:
 *  the type kinds it needs (id target, primitive name, enum-vs-VO) are all
 *  reachable through the post-link cross-references. */
export function scalarColumnsForAggregate(agg: Aggregate): ScaffoldColumn[] {
  return columnsFromProperties(apiVisibleProperties(agg.members));
}

/** One `ScaffoldColumn` per displayable property — dispatched by type, skipping
 *  value-objects/arrays.  Shared by the aggregate-list and view-list columns. */
function columnsFromProperties(props: readonly Property[]): ScaffoldColumn[] {
  const out: ScaffoldColumn[] = [];
  for (const p of props) {
    const kind = columnKindForType(p.type);
    if (kind) out.push({ name: String(p.name), kind });
  }
  return out;
}

function propertiesOf(members: readonly { $type: string }[]): Property[] {
  return members.filter((m): m is Property => m.$type === "Property");
}

/** The aggregate-root properties a scaffold LIST or DETAIL page may render.
 *  The API-read wire shape excludes `internal`/`secret`-access fields
 *  (`forApiRead`, src/ir/enrich/wire-projection.ts), so the client DTO never
 *  carries them — a scaffold that displayed them would reference a column that
 *  doesn't exist on the response type and fail `tsc`.  Capability mixins inject
 *  exactly such fields (`tenantOwned` → `tenantId`/`dataKey` internal,
 *  `softDeletable` → `isDeleted` internal), which is why a plain `with
 *  scaffold` over a `tenantOwned`/`softDeletable` aggregate would otherwise
 *  emit an uncompilable frontend.  (Views keep the wider set on purpose — an
 *  admin view response may include `internal` — so this narrowing is applied
 *  only at the crudish aggregate list/detail sites, not `viewColumnFields`.) */
function apiVisibleProperties(members: readonly { $type: string }[]): Property[] {
  return propertiesOf(members).filter((p) => p.access !== "internal" && p.access !== "secret");
}

/** Dispatch a field's display `kind` from its AST type.  Arrays never have a
 *  scalar cell (→ null).  `voAsText` decides value-objects: list/table columns
 *  skip them (`false`, → null),
 *  the detail rows render them as plain `Text` (`true`, the
 *  fallback over a `data.<vo>` receiver). */
function kindForType(type: TypeRef, voAsText: boolean): ColumnKind | null {
  if (type.array) return null; // arrays have no scalar cell
  const base = type.base;
  if (base.$type === "IdType") {
    return { tag: "id", targetName: base.target.ref?.name ?? base.target.$refText };
  }
  if (base.$type === "PrimitiveType") {
    switch (base.name) {
      case "datetime":
        return { tag: "datetime" };
      case "bool":
        return { tag: "bool" };
      case "decimal":
      case "money":
      case "int":
      case "long":
        return { tag: "numeric" };
      default: // string / guid / json — plain text
        return { tag: "text" };
    }
  }
  if (base.$type === "NamedType") {
    if (base.target.ref?.$type === "EnumDecl") return { tag: "enum" };
    return voAsText ? { tag: "text" } : null; // value-object
  }
  return voAsText ? { tag: "text" } : null;
}

function columnKindForType(type: TypeRef): ColumnKind | null {
  return kindForType(type, false);
}

/** A repository `find` the list filter-bar turns into a text-input arm — its
 *  name and the (all-string) param names the inputs bind to. */
export interface FilterFind {
  name: string;
  params: readonly string[];
}

/** Resolve a list's filter finds from the aggregate's repository in the same
 *  context: each `find` (excluding the synthetic `all`) whose params are all
 *  plain non-array/non-optional strings and whose return is an unwrapped list.
 *  Filters the aggregate's repository finds to the bar-eligible ones — the repository
 *  is a sibling `ContextMember`, so it's reachable from the aggregate's AST
 *  without lowering. */
export function filterFindsForAggregate(agg: Aggregate): FilterFind[] {
  const out: FilterFind[] = [];
  for (const m of agg.$container.members) {
    if (m.$type !== "Repository") continue;
    if (m.aggregate.ref?.name !== agg.name && m.aggregate.$refText !== agg.name) continue;
    for (const f of m.finds) {
      if (f.name === "all") continue;
      if (!f.returnType.array) continue;
      if (f.params.length === 0) continue;
      if (!f.params.every((p) => isPlainString(p.type))) continue;
      out.push({ name: f.name, params: f.params.map((p) => String(p.name)) });
    }
  }
  return out;
}

function isPlainString(type: TypeRef): boolean {
  return (
    !type.array &&
    !type.optional &&
    type.base.$type === "PrimitiveType" &&
    type.base.name === "string"
  );
}

/** The page-state field name a filter input binds to: `<find><Param>`
 *  (camel-joined). */
export function stateNameFor(findName: string, param: string): string {
  return `${findName}${param[0]!.toUpperCase()}${param.slice(1)}`;
}

/** The page-state fields the scaffolded filter inputs bind to — one `string`
 *  field (init `""`) per find param.  The page builder attaches these as the
 *  page's `state { }` block when wiring `scaffoldList`'s filter form. */
export function filterStateFields(filters: readonly FilterFind[]): Array<{ name: string }> {
  return filters.flatMap((f) => f.params.map((p) => ({ name: stateNameFor(f.name, p) })));
}

/** `scaffoldList` — scaffolds the list page body: breadcrumbs, a toolbar with
 *  a "New <agg>" button, and a `QueryView` over `<api?>.<Agg>.all` rendering a
 *  Paper-framed `Table` (ID column + one column per scalar field).  The
 *  no-filter list path.  `columns` are the scalar columns
 *  the caller resolved off the aggregate (`scalarColumnsForAggregate`), each
 *  carrying its display `kind`; `apiHandle` is the ui's api param when the
 *  aggregate is served over one. */
export function scaffoldList(
  aggName: string,
  columns: readonly ScaffoldColumn[],
  opts: { apiHandle?: string; filters?: readonly FilterFind[]; paged?: boolean } = {},
): Expression {
  // Whether the aggregate's implicit `all` is the paged `Paged<T>` findAll
  // (M-T2.6).  Mirrors the enrichment-side exclusion in
  // `ensureFindAll` (src/ir/enrich/enrichments.ts) — a plain single-table
  // relational aggregate pages; document/embedded/event-sourced/inheritance
  // shapes keep the bare `T[]` and a CLIENT-paged list.  Defaults to paged so
  // relational callers that don't classify stay server-paged.
  const serverPagedAll = opts.paged ?? true;
  const slug = snake(plural(aggName));
  const humanPlural = humanize(plural(aggName));
  const humanLower = humanPlural.toLowerCase();
  const singular = humanize(aggName).toLowerCase();
  const filters = opts.filters ?? [];

  // `<api?>.<Agg>` query root, rebuilt per use — AST nodes can't be shared
  // across parents, and the filter `match` reads it once per arm + the `all`
  // fallback.
  const queryRoot = (): Expression =>
    opts.apiHandle ? memberAccess(nameRefExpr(opts.apiHandle), aggName) : nameRefExpr(aggName);

  // One Column per field; the ID column links to the detail page, the rest
  // dispatch their cell renderer by type (`columnAccessor`).  Rebuilt per
  // QueryView so the filter `match`'s several views never share nodes.
  // Every scaffold column is `sortable:` — a click on its header sorts the
  // list client-side (M-T1.1).  `field:` names the row property to sort by
  // (the accessor may wrap it — money/date cells — so it's passed explicitly);
  // the ID column sorts by `"id"`.
  const makeCols = (): Array<{ name?: string; value: Expression }> => [
    {
      value: callExpr("Column", [
        { value: stringLit("ID") },
        {
          value: lambda(
            "o",
            callExpr("IdLink", [
              { value: memberAccess(nameRefExpr("o"), "id") },
              { name: "of", value: nameRefExpr(aggName) },
            ]),
          ),
        },
        { name: "sortable", value: boolLit(true) },
        { name: "field", value: stringLit("id") },
      ]),
    },
    ...columns.map((c) => ({
      value: callExpr("Column", [
        { value: stringLit(humanize(c.name)) },
        { value: lambda("o", columnAccessor(c.name, c.kind, "o")) },
        { name: "sortable", value: boolLit(true) },
        { name: "field", value: stringLit(c.name) },
      ]),
    })),
  ];

  // The Table for one QueryView `data:` arm.  `serverPaged` (the `all` list,
  // M-T2.6) reads the server's page off the `Paged<T>` envelope: rows are
  // `rows.items`, the pager's page count is `rows.totalPages`, and the sortable
  // headers + pager write `pageNum`/`sortKey`/`sortDir` state that the query's
  // `of:` args feed back for a refetch (no client slice/sort).  A filter view
  // (a user `find … : T[]`, unbounded array) stays CLIENT-paged: `rows` is the
  // array, sliced/sorted in the browser.
  const makeTable = (serverPaged: boolean): Expression =>
    callExpr("Table", [
      ...makeCols(),
      {
        name: "rows",
        value: serverPaged ? memberAccess(nameRefExpr("rows"), "items") : nameRefExpr("rows"),
      },
      { name: "sortKey", value: nameRefExpr("sortKey") },
      { name: "sortDir", value: nameRefExpr("sortDir") },
      { name: "page", value: nameRefExpr("pageNum") },
      ...(serverPaged
        ? [
            { name: "serverPaged", value: boolLit(true) },
            { name: "totalPages", value: memberAccess(nameRefExpr("rows"), "totalPages") },
          ]
        : [{ name: "pageSize", value: intLit(10) }]),
      { name: "striped", value: boolLit(true) },
      { name: "highlight", value: boolLit(true) },
      { name: "sticky", value: boolLit(true) },
      {
        name: "rowTestid",
        value: lambda(
          "r",
          binaryExpr(stringLit(`${slug}-row-`), "+", memberAccess(nameRefExpr("r"), "id")),
        ),
      },
    ]);

  // One QueryView per query expression — built per call so the filter arms
  // below never share `ExprIR`/AST nodes.  `paged` marks the server-paged `all`
  // view (unwrap `.data.items`; the Table reads the envelope).
  const makeQueryView = (ofExpr: Expression, serverPaged: boolean): Expression =>
    callExpr("QueryView", [
      { name: "of", value: ofExpr },
      ...(serverPaged ? [{ name: "paged", value: boolLit(true) }] : []),
      { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(5) }]) },
      {
        name: "error",
        value: callExpr("Alert", [{ value: stringLit(`Couldn't load ${humanLower}`) }]),
      },
      { name: "empty", value: callExpr("Empty", [{ value: stringLit(`No ${humanLower} yet.`) }]) },
      {
        name: "data",
        value: lambda("rows", callExpr("Paper", [{ value: makeTable(serverPaged) }])),
      },
    ]);

  // The `all` list is server-paged: the `of:` threads the list's page/sort state
  // (`pageNum`, fixed pageSize 10, `sortKey`, `sortDir`) as the paged findAll's
  // query controls, so a page/sort change refetches the matching server page.
  const allView = (): Expression =>
    serverPagedAll
      ? makeQueryView(
          memberAccess(queryRoot(), "all", {
            call: true,
            args: [
              nameRefExpr("pageNum"),
              intLit(10),
              nameRefExpr("sortKey"),
              nameRefExpr("sortDir"),
            ],
          }),
          true,
        )
      : // A non-paged `all` (document/embedded/eventLog/inheritance shape) is a
        // bare `T[]` — call it with no args and CLIENT-slice/sort in the browser.
        makeQueryView(memberAccess(queryRoot(), "all", { call: true, args: [] }), false);

  // Find-filter bar (T3.14): each qualifying `find` gets one text input per
  // param; when every input of a find is non-empty the list switches to that
  // find's results (first matching arm wins), else `all` renders.  The
  // list's filter block; the page-state fields the inputs bind
  // to are resolved by `filterStateFields`, attached by the page builder.
  const filterFields: Array<{ name?: string; value: Expression }> = [];
  let listRegion: Expression = allView();
  if (filters.length > 0) {
    for (const f of filters) {
      for (const p of f.params) {
        const stateName = stateNameFor(f.name, p);
        filterFields.push({
          value: callExpr("Field", [
            { value: stringLit(humanize(p)) },
            { name: "bind", value: nameRefExpr(stateName) },
            { name: "testid", value: stringLit(`${slug}-filter-${snake(stateName)}`) },
          ]),
        });
      }
    }
    listRegion = matchExpr(
      filters.map((f) => ({
        cond: f.params
          .map(
            (p): Expression =>
              binaryExpr(nameRefExpr(stateNameFor(f.name, p)), "!=", stringLit("")),
          )
          .reduce((acc, e) => binaryExpr(acc, "&&", e)),
        value: makeQueryView(
          memberAccess(queryRoot(), f.name, {
            call: true,
            args: f.params.map((p) => nameRefExpr(stateNameFor(f.name, p))),
          }),
          false,
        ),
      })),
      allView(),
    );
  }

  return callExpr("Stack", [
    { value: breadcrumbs(humanPlural, slug) },
    {
      value: callExpr("Toolbar", [
        {
          value: callExpr("Heading", [
            { value: stringLit(humanPlural) },
            { name: "level", value: intLit(2) },
          ]),
        },
        {
          value: callExpr("Button", [
            { value: stringLit(`New ${singular}`) },
            { name: "to", value: stringLit(`/${slug}/new`) },
            { name: "testid", value: stringLit(`${slug}-list-create`) },
          ]),
        },
      ]),
    },
    ...(filterFields.length > 0 ? [{ value: callExpr("Group", filterFields) }] : []),
    { value: listRegion },
    { name: "testid", value: stringLit(`${slug}-list`) },
  ]);
}

/** `Breadcrumbs(Anchor("Home", to:"/"), …)` — the list page ends at a plain
 *  `Text(<plural>)`; the new/detail pages add a trailing crumb (`leaf`). */
function breadcrumbs(humanPlural: string, slug: string, leaf?: string): Expression {
  const crumbs: Array<{ name?: string; value: Expression }> = [
    {
      value: callExpr("Anchor", [
        { value: stringLit("Home") },
        { name: "to", value: stringLit("/") },
      ]),
    },
  ];
  if (leaf) {
    crumbs.push({
      value: callExpr("Anchor", [
        { value: stringLit(humanPlural) },
        { name: "to", value: stringLit(`/${slug}`) },
      ]),
    });
    crumbs.push({ value: callExpr("Text", [{ value: stringLit(leaf) }]) });
  } else {
    crumbs.push({ value: callExpr("Text", [{ value: stringLit(humanPlural) }]) });
  }
  return callExpr("Breadcrumbs", crumbs);
}

// Naming helpers — copied verbatim from `_pages.ts` (kept module-local so the
// scaffold macro family doesn't pull in the wider `util/naming` dep graph;
// dedup is a follow-up once the builders consolidate).

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

function humanize(s: string): string {
  const parts = s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
