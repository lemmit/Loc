// Macro-layer (AST→AST) scaffolders for page bodies.
//
// These are the unfoldable twins of the IR-phase expanders in
// `src/ir/lower/walker-primitive-expander.ts`.  Where the ⑤c expanders build
// `ExprIR` (opaque, never printable), these build the SAME tree as Langium
// AST, so a scaffolder's output prints to literal `.ddd` source and unfolds
// like any other macro.  `scaffoldList` scaffolds a list; `scaffoldNewForm`
// scaffolds a new-form — the name is the spec.  See
// `docs/proposals/unfoldable-page-scaffolding.md`.
//
// Status: the AST builders + a print/re-parse proof.  Wiring them into
// `_pages.ts` (so the scaffold macro RETURNS these instead of sentinels) and
// deleting the ⑤c arms + `inferPageOrigin` is the cohesive flip that follows,
// gated on equivalent generated output.  Built so far, all faithful twins of
// the matching ⑤c expanders: `scaffoldList` (per-type columns + `rowTestid` +
// the find-filter bar), `scaffoldNewForm`, `scaffoldOperations`,
// `scaffoldWorkflowForm`, `scaffoldViewList`.  The Detail builder
// (`scaffoldDetails`/value-object + related cards) and the workflow-instance
// list/detail builders, plus attaching the filter state as the page's
// `state { }` block when wiring, are the remaining tail.

import type {
  Aggregate,
  Expression,
  Operation,
  Property,
  TypeRef,
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
 *  `Stack(Breadcrumbs, Heading "Create <agg>", Card(CreateForm(of:)))`.
 *  AST twin of `expandScaffoldNewForm`. */
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
 *  operations ⇒ an empty `Group()`.  AST twin of `expandScaffoldOperations`;
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
 *  `Stack(Breadcrumbs, Heading, Card(WorkflowForm(runs: <Wf>)))`.  AST twin of
 *  `expandScaffoldWorkflowForm`. */
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
 *  `Stack(Heading, QueryView(of: Views.<View>, …, Paper(Table)))`.  AST twin of
 *  `expandScaffoldViewList`.  Columns come from the view's own output record
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

/** A workflow's persisted-instance properties in wire-shape order — the single
 *  id-shaped correlation field first (the `token`), then the remaining state
 *  fields in declaration order.  Twin of `wireFieldsForWorkflow`; an absent or
 *  ambiguous correlation ⇒ no instance shape (empty), matching the enrichment
 *  gate.  Shared by the view-list and (later) the instance builders. */
function workflowInstanceProperties(wf: Workflow): Property[] {
  const props = propertiesOf(wf.members);
  const idProps = props.filter((p) => p.type.base.$type === "IdType" && !p.type.array);
  if (idProps.length !== 1) return [];
  const corr = idProps[0]!;
  return [corr, ...props.filter((p) => p.name !== corr.name)];
}

/** The display dispatch a list/table column renders through — the
 *  macro-layer mirror of `columnAccessorFor`'s type switch in
 *  `walker-primitive-expander.ts`.  Resolved from the aggregate's AST at
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

/** One table cell accessor `<rowVar>.<field>`, wrapped per type exactly as
 *  the ⑤c `columnAccessorFor` does: ids link, datetimes format, bools render
 *  a Yes/No ternary, enums badge, everything else is plain `Text`. */
function columnAccessor(fieldName: string, kind: ColumnKind, rowVar: string): Expression {
  const cell = (): Expression => memberAccess(nameRefExpr(rowVar), fieldName);
  switch (kind.tag) {
    case "id":
      return callExpr("IdLink", [
        { value: cell() },
        { name: "of", value: nameRefExpr(kind.targetName) },
      ]);
    case "datetime":
      return callExpr("DateDisplay", [{ value: cell() }]);
    case "bool":
      return callExpr("Text", [{ value: ternaryExpr(cell(), stringLit("Yes"), stringLit("No")) }]);
    case "enum":
      return callExpr("EnumBadge", [{ value: cell() }]);
    default: // "numeric" | "text"
      return callExpr("Text", [{ value: cell() }]);
  }
}

/** Resolve an aggregate's scalar list columns from its AST — one `ScaffoldColumn`
 *  per non-array `Property`, dispatched by the field's resolved type, skipping
 *  value-object fields (no scalar cell, matching `expandScaffoldList`).  This is
 *  the "compute it at macro time" twin of the ⑤c loop over lowered `agg.fields`:
 *  the type kinds it needs (id target, primitive name, enum-vs-VO) are all
 *  reachable through the post-link cross-references. */
export function scalarColumnsForAggregate(agg: Aggregate): ScaffoldColumn[] {
  return columnsFromProperties(propertiesOf(agg.members));
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

function columnKindForType(type: TypeRef): ColumnKind | null {
  if (type.array) return null; // arrays have no scalar column cell
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
    // Enum → badge; a value-object (or any other named type) has no scalar
    // column cell, mirroring the expander's `valueobject` skip.
    return base.target.ref?.$type === "EnumDecl" ? { tag: "enum" } : null;
  }
  return null;
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
 *  Twin of the ⑤c `filterFinds` filter over the lowered repo — the repository
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
 *  (camel-joined), matching the ⑤c `stateNameFor`. */
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
 *  Paper-framed `Table` (ID column + one column per scalar field).  AST twin
 *  of `expandScaffoldList`'s no-filter path.  `columns` are the scalar columns
 *  the caller resolved off the aggregate (`scalarColumnsForAggregate`), each
 *  carrying its display `kind`; `apiHandle` is the ui's api param when the
 *  aggregate is served over one. */
export function scaffoldList(
  aggName: string,
  columns: readonly ScaffoldColumn[],
  opts: { apiHandle?: string; filters?: readonly FilterFind[] } = {},
): Expression {
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
      ]),
    },
    ...columns.map((c) => ({
      value: callExpr("Column", [
        { value: stringLit(humanize(c.name)) },
        { value: lambda("o", columnAccessor(c.name, c.kind, "o")) },
      ]),
    })),
  ];

  const makeTable = (): Expression =>
    callExpr("Table", [
      ...makeCols(),
      { name: "rows", value: nameRefExpr("rows") },
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
  // below never share `ExprIR`/AST nodes.
  const makeQueryView = (ofExpr: Expression): Expression =>
    callExpr("QueryView", [
      { name: "of", value: ofExpr },
      { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(5) }]) },
      {
        name: "error",
        value: callExpr("Alert", [{ value: stringLit(`Couldn't load ${humanLower}`) }]),
      },
      { name: "empty", value: callExpr("Empty", [{ value: stringLit(`No ${humanLower} yet.`) }]) },
      { name: "data", value: lambda("rows", callExpr("Paper", [{ value: makeTable() }])) },
    ]);

  const allView = (): Expression => makeQueryView(memberAccess(queryRoot(), "all"));

  // Find-filter bar (T3.14): each qualifying `find` gets one text input per
  // param; when every input of a find is non-empty the list switches to that
  // find's results (first matching arm wins), else `all` renders.  Twin of
  // `expandScaffoldList`'s filter block; the page-state fields the inputs bind
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
