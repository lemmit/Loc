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
// gated on equivalent generated output.  `scaffoldList` now carries the
// per-type column formatters (`columnAccessor` / `scalarColumnsForAggregate`,
// twins of the ⑤c `columnAccessorFor`) and the `rowTestid` accessor; the
// filter-bar (find inputs + page state) is the remaining tail.

import type { Aggregate, Expression, TypeRef } from "../../../language/generated/ast.js";
import {
  binaryExpr,
  boolLit,
  callExpr,
  intLit,
  lambda,
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
  const out: ScaffoldColumn[] = [];
  for (const m of agg.members) {
    if (m.$type !== "Property") continue;
    const kind = columnKindForType(m.type);
    if (kind) out.push({ name: m.name, kind });
  }
  return out;
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
  opts: { apiHandle?: string } = {},
): Expression {
  const slug = snake(plural(aggName));
  const humanPlural = humanize(plural(aggName));
  const humanLower = humanPlural.toLowerCase();
  const singular = humanize(aggName).toLowerCase();
  const queryRoot = opts.apiHandle
    ? memberAccess(nameRefExpr(opts.apiHandle), aggName)
    : nameRefExpr(aggName);

  // One Column per field; the ID column links to the detail page, the rest
  // dispatch their cell renderer by type (`columnAccessor`).
  const cols: Array<{ name?: string; value: Expression }> = [
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

  const table = callExpr("Table", [
    ...cols,
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

  const queryView = callExpr("QueryView", [
    { name: "of", value: memberAccess(queryRoot, "all") },
    { name: "loading", value: callExpr("Skeleton", [{ name: "count", value: intLit(5) }]) },
    {
      name: "error",
      value: callExpr("Alert", [{ value: stringLit(`Couldn't load ${humanLower}`) }]),
    },
    { name: "empty", value: callExpr("Empty", [{ value: stringLit(`No ${humanLower} yet.`) }]) },
    { name: "data", value: lambda("rows", callExpr("Paper", [{ value: table }])) },
  ]);

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
    { value: queryView },
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
