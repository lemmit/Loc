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
// gated on equivalent generated output.  The filter-bar (find inputs + page
// state) and per-type column formatters are the remaining tail.

import type { Expression } from "../../../language/generated/ast.js";
import {
  boolLit,
  callExpr,
  intLit,
  lambda,
  memberAccess,
  nameRefExpr,
  stringLit,
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

/** `scaffoldList` — scaffolds the list page body: breadcrumbs, a toolbar with
 *  a "New <agg>" button, and a `QueryView` over `<api?>.<Agg>.all` rendering a
 *  Paper-framed `Table` (ID column + one column per scalar field).  AST twin
 *  of `expandScaffoldList`'s no-filter path.  `columns` are the scalar field
 *  names the caller pulled off the aggregate (skipping value-objects/arrays);
 *  `apiHandle` is the ui's api param when the aggregate is served over one. */
export function scaffoldList(
  aggName: string,
  columns: readonly string[],
  opts: { apiHandle?: string } = {},
): Expression {
  const slug = snake(plural(aggName));
  const humanPlural = humanize(plural(aggName));
  const humanLower = humanPlural.toLowerCase();
  const singular = humanize(aggName).toLowerCase();
  const queryRoot = opts.apiHandle
    ? memberAccess(nameRefExpr(opts.apiHandle), aggName)
    : nameRefExpr(aggName);

  // One Column per field; the ID column links to the detail page.
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
        { value: stringLit(humanize(c)) },
        { value: lambda("o", memberAccess(nameRefExpr("o"), c)) },
      ]),
    })),
  ];

  const table = callExpr("Table", [
    ...cols,
    { name: "rows", value: nameRefExpr("rows") },
    { name: "striped", value: boolLit(true) },
    { name: "highlight", value: boolLit(true) },
    { name: "sticky", value: boolLit(true) },
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
