// Shared page-generation helpers for the scaffold macro family.
//
// Each `scaffold<X>` macro (scaffoldAggregate / scaffoldWorkflow /
// scaffoldView / scaffold) reaches into these to emit canonical page
// shapes.  Keeping them in one place means the per-archetype leaf
// macros and the top-level composer share one source of truth.

import type { Aggregate, Page, View, Workflow } from "../../api/index.js";
import { boolLit, callExpr, nameRefExpr, page, stringLit } from "../../api/index.js";

export function pagesForAggregate(agg: Aggregate): Page[] {
  const pluralSnake = snake(plural(agg.name));
  const aggName = agg.name;
  const labelPlural = humanize(plural(aggName));
  return [
    page({
      name: `${aggName}List`,
      route: `/${pluralSnake}`,
      // Canonical body primitive — expands inline to the full
      // Breadcrumbs/Toolbar/QueryView/Table tree via
      // `expandInlineScaffoldPrimitives`.
      body: callExpr("scaffoldList", [{ name: "of", value: nameRefExpr(aggName) }]),
      menu: {
        section: stringLit("Aggregates"),
        label: stringLit(labelPlural),
      },
    }),
    page({
      name: `${aggName}New`,
      route: `/${pluralSnake}/new`,
      // Canonical body primitive — expands to Stack(Breadcrumbs,
      // Heading, Card(CreateForm(of:))).
      body: callExpr("scaffoldNewForm", [{ name: "of", value: nameRefExpr(aggName) }]),
      menu: { hidden: boolLit(true) },
    }),
    page({
      name: `${aggName}Detail`,
      route: `/${pluralSnake}/:id`,
      // Explicit Stack of two body primitives — see
      // `expandInlineScaffoldPrimitives` in
      // src/ir/walker-primitive-expander.ts.
      //
      //   * scaffoldDetails(of: <Agg>)    — full read view
      //     (Breadcrumbs, Heading, QueryView wrapping the field
      //     card + related-entity cards).  Customisable: replacing
      //     this slot with custom JSX doesn't disturb operations.
      //   * scaffoldOperations(of: <Agg>) — Group(Modal × N), one
      //     per public operation.  Auto-fans at lowering time, so
      //     adding `operation reactivate()` to the aggregate makes
      //     its modal appear without touching this page.
      body: callExpr("Stack", [
        {
          value: callExpr("scaffoldDetails", [{ name: "of", value: nameRefExpr(aggName) }]),
        },
        {
          value: callExpr("scaffoldOperations", [{ name: "of", value: nameRefExpr(aggName) }]),
        },
        // testid on the outer Stack — the e2e page-objects anchor
        // on `<plural>-detail`.
        { name: "testid", value: stringLit(`${pluralSnake}-detail`) },
      ]),
      menu: { hidden: boolLit(true) },
    }),
  ];
}

export function pageForWorkflow(wf: Workflow): Page {
  return page({
    name: `${pascal(wf.name)}Workflow`,
    route: `/workflows/${snake(wf.name)}`,
    // Canonical body primitive — expands to Stack(Breadcrumbs,
    // Heading, Card(WorkflowForm(runs:))).
    body: callExpr("scaffoldWorkflowForm", [{ name: "runs", value: nameRefExpr(wf.name) }]),
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
    // Canonical body primitive — expands to Heading + QueryView
    // wrapping a Paper-framed Table over the view's projected rows.
    body: callExpr("scaffoldViewList", [{ name: "of", value: nameRefExpr(v.name) }]),
    menu: {
      section: stringLit("Views"),
      label: stringLit(humanize(v.name)),
    },
  });
}

export function homePage(): Page {
  return page({
    name: "Home",
    route: "/",
    body: callExpr("Home", []),
    menu: { hidden: boolLit(true) },
  });
}

export function workflowsIndexPage(): Page {
  return page({
    name: "WorkflowsIndex",
    route: "/workflows",
    body: callExpr("WorkflowsIndex", []),
    menu: {
      section: stringLit("Workflows"),
      label: stringLit("Index"),
    },
  });
}

export function viewsIndexPage(): Page {
  return page({
    name: "ViewsIndex",
    route: "/views",
    body: callExpr("ViewsIndex", []),
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
